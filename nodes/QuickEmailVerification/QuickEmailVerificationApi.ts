import type { IExecuteFunctions, IDataObject } from 'n8n-workflow';
import { version as packageVersion } from '../../package.json';

/** Version of the QuickEmailVerification REST API this node targets. */
export const API_VERSION = 'v1';

const API_BASE = `https://api.quickemailverification.com/${API_VERSION}`;

/**
 * Sent on every request so QuickEmailVerification can attribute traffic to this
 * node. The version is read from package.json so a release bump updates it.
 */
export const USER_AGENT = `quickemailverification-n8n/v${packageVersion} (https://github.com/quickemailverification/n8n-nodes-quickemailverification)`;

/** Headers every request carries, merged with any request-specific ones. */
function baseHeaders(extra: IDataObject = {}): IDataObject {
	return { 'User-Agent': USER_AGENT, ...extra };
}

/** The credential type this client authenticates with. */
export const CREDENTIAL_NAME = 'quickEmailVerificationApi';

/**
 * Result of the Verify An Email Address API, returned to the workflow exactly
 * as the API sends it. Field names and meanings follow the API documentation.
 */
export interface IVerifyResult {
	/** valid, invalid, or unknown */
	result: string;
	/** invalid_email, invalid_domain, rejected_email, accepted_email, no_connect, timeout, unavailable_smtp, unexpected_error, no_mx_record, temporarily_blocked, or exceeded_storage */
	reason: string;
	disposable: boolean;
	accept_all: boolean;
	role: boolean;
	free: boolean;
	email: string;
	user: string;
	domain: string;
	/** The preferred MX record of the email domain, e.g. "us2.mx1.mailhostbox.com" */
	mx_record: string;
	/** The domain name of the MX host */
	mx_domain: string;
	safe_to_send: boolean;
	did_you_mean: string;
	success: boolean;
	message?: string | null;
	[key: string]: unknown;
}

/** Response returned by the Verify Email List API when a list is accepted. */
export interface IBulkUploadResult {
	id: string;
	success: boolean;
	message?: string;
	filename?: string;
	/** Item totals are not guaranteed by the API; whichever key is present is used. */
	item_count?: number;
	count?: number;
	total?: number;
	[key: string]: unknown;
}

/** Response returned by the Check Job Status API. */
export interface IBulkStatus {
	id?: string;
	filename?: string;
	status: string;
	created_date?: string;
	started_date?: string;
	completed_date?: string;
	processing_time?: number;
	stats?: {
		total_email?: number;
		progress?: string;
		result_counts?: Record<string, number>;
		[key: string]: unknown;
	};
	download_urls?: Record<string, string>;
	message?: string;
	success?: boolean;
	[key: string]: unknown;
}

/** A downloaded report, with the headers the server sent it with. */
export interface IDownloadResult {
	body: Buffer;
	headers: IDataObject;
}

/** Response returned by the Delete Email Job API. */
export interface IBulkDeleteResult {
	id?: string;
	success?: boolean;
	message?: string;
	[key: string]: unknown;
}

/** Optional metadata accepted when uploading an email list. */
export interface IBulkUploadOptions {
	filename?: string;
	callbackUrl?: string;
	notificationEmail?: string;
}

/** Translate a failed n8n HTTP request into a readable, user-facing error. */
function mapHttpError(error: unknown): Error {
	const err = (error ?? {}) as {
		statusCode?: number;
		httpCode?: number | string;
		response?: { statusCode?: number; body?: unknown; data?: unknown };
		message?: string;
	};
	const status = Number(err.statusCode ?? err.httpCode ?? err.response?.statusCode ?? 0);
	const body = err.response?.body ?? err.response?.data;

	let apiMessage: string | undefined;
	if (body && typeof body === 'object') {
		const parsed = body as { message?: string; error?: string };
		apiMessage = parsed.message ?? parsed.error;
	}

	switch (status) {
		case 400:
			return new Error(apiMessage ?? 'Bad request: the file or parameters are invalid');
		case 401:
			return new Error('Invalid API key');
		case 402:
			return new Error(apiMessage ?? 'Insufficient credits to complete the request');
		case 404:
			return new Error(apiMessage ?? 'The requested resource was not found');
		case 429:
			return new Error('Rate limit exceeded');
		default:
			return new Error(
				apiMessage ?? err.message ?? `Request failed with HTTP status ${status || 'unknown'}`,
			);
	}
}

/**
 * Client for the QuickEmailVerification REST API, built on n8n's request
 * helpers so it inherits the instance's proxy, TLS, and timeout settings.
 * Covers single verification and the email list lifecycle
 * (verify list -> job status -> download report -> delete job).
 */
export class QuickEmailVerificationClient {
	constructor(private readonly ctx: IExecuteFunctions) {}

	/** Verify a single email address. */
	async verify(email: string): Promise<IVerifyResult> {
		if (!email) {
			throw new Error('An email address is required');
		}

		let raw: unknown;
		try {
			raw = await this.ctx.helpers.httpRequestWithAuthentication.call(this.ctx, CREDENTIAL_NAME, {
				method: 'GET',
				url: `${API_BASE}/verify`,
				qs: { email },
				headers: baseHeaders({ Accept: 'application/json' }),
				json: true,
			});
		} catch (error) {
			throw mapHttpError(error);
		}

		// The response is returned as-is, so the node output matches the API
		// documentation field for field.
		const data = coerceJson(raw) as IVerifyResult;
		// `success` is documented as a boolean but the API sends it as a string,
		// so both forms are treated as a failure.
		if (data.success === false || (data.success as unknown) === 'false') {
			throw new Error(data.message || 'The API reported the request as unsuccessful');
		}
		return data;
	}

	/** Verify an email list: upload the CSV/TXT file and return the job id. */
	async uploadList(file: Buffer, options: IBulkUploadOptions = {}): Promise<IBulkUploadResult> {
		if (!file || file.length === 0) {
			throw new Error('The email list file is empty');
		}

		const { body, boundary } = buildMultipart(file, options);
		const headers: IDataObject = baseHeaders({
			'Content-Type': `multipart/form-data; boundary=${boundary}`,
			'Content-Length': String(body.length),
			Accept: 'application/json',
		});
		if (options.filename) {
			headers['X-QEV-Filename'] = options.filename;
		}
		if (options.callbackUrl) {
			headers['X-QEV-Callback'] = options.callbackUrl;
		}

		let raw: unknown;
		try {
			raw = await this.ctx.helpers.httpRequestWithAuthentication.call(this.ctx, CREDENTIAL_NAME, {
				method: 'POST',
				url: `${API_BASE}/bulk-verify`,
				body,
				headers,
				json: false,
			});
		} catch (error) {
			throw mapHttpError(error);
		}

		const data = coerceJson(raw) as IBulkUploadResult;
		if (!data || !data.id) {
			throw new Error(data?.message ?? 'Upload succeeded but no job id was returned');
		}
		return data;
	}

	/** Fetch the current status of an email list verification job. */
	async getStatus(jobId: string): Promise<IBulkStatus> {
		if (!jobId) {
			throw new Error('A job id is required to check status');
		}

		try {
			const raw = await this.ctx.helpers.httpRequestWithAuthentication.call(
				this.ctx,
				CREDENTIAL_NAME,
				{
					method: 'GET',
					url: `${API_BASE}/bulk-verify/status/${encodeURIComponent(jobId)}`,
					headers: baseHeaders({ Accept: 'application/json' }),
					json: true,
				},
			);
			return coerceJson(raw) as IBulkStatus;
		} catch (error) {
			throw mapHttpError(error);
		}
	}

	/**
	 * Delete an uploaded job and its reports.
	 * The API only allows this for jobs created through the API, and not while
	 * a job is still being processed.
	 */
	async deleteJob(jobId: string): Promise<IBulkDeleteResult> {
		if (!jobId) {
			throw new Error('A file id is required to delete a job');
		}

		let data: IBulkDeleteResult;
		try {
			const raw = await this.ctx.helpers.httpRequestWithAuthentication.call(
				this.ctx,
				CREDENTIAL_NAME,
				{
					method: 'GET',
					url: `${API_BASE}/bulk-verify/delete/${encodeURIComponent(jobId)}`,
					headers: baseHeaders({ Accept: 'application/json' }),
					json: true,
				},
			);
			data = coerceJson(raw) as IBulkDeleteResult;
		} catch (error) {
			throw mapHttpError(error);
		}

		if (data.success === false) {
			throw new Error(data.message ?? `The file ${jobId} could not be deleted`);
		}
		return data;
	}

	/**
	 * Download a completed report from a signed URL.
	 * The raw bytes and response headers are both returned so the caller can
	 * build binary data with the file name the server served it under.
	 */
	async download(url: string): Promise<IDownloadResult> {
		if (!url) {
			throw new Error('A download URL is required');
		}

		try {
			const response = (await this.ctx.helpers.httpRequest.call(this.ctx, {
				method: 'GET',
				url,
				headers: baseHeaders(),
				json: false,
				encoding: 'arraybuffer',
				returnFullResponse: true,
			})) as { body: unknown; headers: IDataObject };

			return {
				body: toBuffer(response.body),
				headers: response.headers ?? {},
			};
		} catch (error) {
			throw mapHttpError(error);
		}
	}
}

/** Normalise a response body into a Buffer, whatever shape the helper returned. */
function toBuffer(body: unknown): Buffer {
	if (Buffer.isBuffer(body)) {
		return body;
	}
	if (body instanceof ArrayBuffer) {
		return Buffer.from(body);
	}
	if (ArrayBuffer.isView(body)) {
		return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	}
	return Buffer.from(typeof body === 'string' ? body : String(body ?? ''), 'utf8');
}

/** Parse a response body that may arrive as a JSON string or an already-parsed object. */
function coerceJson(raw: unknown): unknown {
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}
	return raw ?? {};
}

/**
 * Build a multipart boundary that is guaranteed absent from the payload.
 * n8n Cloud forbids `node:crypto`, so instead of relying on cryptographic
 * randomness to avoid a collision, the candidate is checked against the file and
 * a counter is appended until it is genuinely unique.
 */
function makeBoundary(file: Buffer): string {
	const haystack = file.toString('latin1');
	const seed = Math.random().toString(36).slice(2) + Date.now().toString(36);
	let boundary = `----QEVBoundary${seed}`;
	for (let suffix = 0; haystack.includes(boundary); suffix++) {
		boundary = `----QEVBoundary${seed}${suffix}`;
	}
	return boundary;
}

/**
 * Assemble a multipart/form-data body without any external form library.
 * The boundary is randomised so it can never collide with the file contents.
 */
function buildMultipart(
	file: Buffer,
	options: IBulkUploadOptions,
): { body: Buffer; boundary: string } {
	const filename = (options.filename ?? 'list.csv').replace(/"/g, '');
	const boundary = makeBoundary(file);
	const chunks: Buffer[] = [];

	// Notification email is not a documented API field; sent best-effort so it is
	// ignored gracefully by the server if unsupported.
	if (options.notificationEmail) {
		chunks.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="notify_email"\r\n\r\n${options.notificationEmail}\r\n`,
			),
		);
	}

	chunks.push(
		Buffer.from(
			`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="upload"; filename="${filename}"\r\n` +
				'Content-Type: text/csv\r\n\r\n',
		),
	);
	chunks.push(file);
	chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

	return { body: Buffer.concat(chunks), boundary };
}
