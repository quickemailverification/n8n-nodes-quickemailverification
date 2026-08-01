import type {
	IBinaryData,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { QuickEmailVerificationClient } from './QuickEmailVerificationApi';
import type { IBulkStatus, IBulkUploadOptions } from './QuickEmailVerificationApi';
import {
	countListItems,
	csvToJson,
	dedupeByEmail,
	filenameFromHeaders,
	toFileStatus,
} from './helpers';
import {
	buildEmailCsv,
	collectCombinedEmails,
	collectEmails,
	GENERATED_FILENAME,
	InputType,
	itemInputProperties,
} from './itemInput';

export class QuickEmailVerification implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'QuickEmailVerification',
		name: 'quickEmailVerification',
		icon: 'file:quickemailverification.svg',
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle:
			'={{$parameter["operation"] === "bulkSendFile" ? "List Verification Send File" : ' +
			'$parameter["operation"] === "bulkFileStatus" ? "List Verification File Status" : ' +
			'$parameter["operation"] === "bulkGetFile" ? "List Verification Get File" : ' +
			'$parameter["operation"] === "bulkDeleteFile" ? "List Verification Delete File" : "Verify an Email Address"}}',
		description: 'Verify a single email address or an email list with QuickEmailVerification',
		defaults: { name: 'QuickEmailVerification' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'quickEmailVerificationApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Verify an Email Address',
						value: 'verifyEmail',
						description: 'Verify a single email address (real-time)',
						action: 'Verify an email address',
					},
					{
						name: 'List Verification Send File',
						value: 'bulkSendFile',
						description: 'Upload a file to QuickEmailVerification for bulk email verification',
						action: 'List verification send file',
					},
					{
						name: 'List Verification File Status',
						value: 'bulkFileStatus',
						description: 'Retrieve the verification status of a previously submitted file',
						action: 'List verification file status',
					},
					{
						name: 'List Verification Get File',
						value: 'bulkGetFile',
						description: 'Download the verification results for a previously submitted file',
						action: 'List verification get file',
					},
					{
						name: 'List Verification Delete File',
						value: 'bulkDeleteFile',
						description:
							'Delete a previously submitted verification file and its associated results',
						action: 'List verification delete file',
					},
				],
				default: 'verifyEmail',
			},

			// --- Verify an Email Address ---
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'name@example.com',
				displayOptions: { show: { operation: ['verifyEmail'] } },
				description: 'The email address to verify',
			},

			// --- List Verification Send File ---
			// eslint-disable-next-line n8n-nodes-base/node-param-default-missing -- default is a const, not a literal
			{
				displayName: 'Input Type',
				name: 'inputType',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'File',
						value: InputType.FILE,
						description: 'An existing CSV/TXT file',
					},
					{
						name: 'Items',
						value: InputType.ITEMS,
						description: 'A new file built from input items',
					},
				],
				default: InputType.FILE,
				displayOptions: { show: { operation: ['bulkSendFile'] } },
				description:
					'Type of input for the file to send. An existing file, or input fields to create a new file.',
			},
			{
				displayName: 'Upload Method',
				name: 'uploadMethod',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Binary File',
						value: 'binary',
						description: 'Use a CSV/TXT file received as binary data from a previous node',
					},
					{
						name: 'File Path',
						value: 'path',
						description: 'Read a CSV/TXT file from an absolute path on the n8n machine',
					},
				],
				default: 'binary',
				displayOptions: { show: { operation: ['bulkSendFile'], inputType: [InputType.FILE] } },
				description: 'How the email list file is provided',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				required: true,
				hint: 'Name of the binary property holding the CSV/TXT list',
				displayOptions: {
					show: {
						operation: ['bulkSendFile'],
						inputType: [InputType.FILE],
						uploadMethod: ['binary'],
					},
				},
				description: 'The binary property that contains the file to upload',
			},
			{
				displayName: 'File Path',
				name: 'filePath',
				type: 'string',
				default: '',
				required: true,
				placeholder: '/data/emails.csv',
				displayOptions: {
					show: {
						operation: ['bulkSendFile'],
						inputType: [InputType.FILE],
						uploadMethod: ['path'],
					},
				},
				description:
					'Absolute path to a local CSV/TXT file to upload. The file is read from the n8n host, so only use paths you trust.',
			},
			...itemInputProperties,
			{
				displayName: 'Filename',
				name: 'filename',
				type: 'string',
				default: '',
				placeholder: 'n8n_validation.csv',
				displayOptions: { show: { operation: ['bulkSendFile'] } },
				description:
					'Optional custom name for the uploaded list, sent as X-QEV-Filename. Defaults to the binary file name or path base name.',
			},
			{
				displayName: 'Return URL',
				name: 'callbackUrl',
				type: 'string',
				default: '',
				placeholder: 'https://example.com/qev-callback',
				displayOptions: { show: { operation: ['bulkSendFile'] } },
				description:
					'Optional URL the API will POST the results to once verification completes, sent as X-QEV-Callback. The API retries up to 3 times until it gets a 2xx response.',
			},
			{
				displayName: 'Notification Email',
				name: 'notificationEmail',
				type: 'string',
				default: '',
				placeholder: 'you@example.com',
				displayOptions: { show: { operation: ['bulkSendFile'] } },
				description: 'Optional address to notify when verification completes',
			},

			// --- List Verification File Status / Get File / Delete File ---
			{
				displayName: 'File ID',
				name: 'fileId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'eee3bb69-0176-4646-9bfc-79dd6c5ded5f',
				displayOptions: {
					show: { operation: ['bulkFileStatus', 'bulkGetFile', 'bulkDeleteFile'] },
				},
				description:
					'The ID of the file submitted for verification, returned as file_id by List Verification Send File',
			},

			// --- List Verification Get File ---
			{
				displayName: 'Report',
				name: 'report',
				type: 'options',
				options: [
					{ name: 'Full Report (All Emails)', value: 'fullreport' },
					{ name: 'Safe to Send', value: 'safetosend' },
					{ name: 'Valid', value: 'valid' },
					{ name: 'Invalid', value: 'invalid' },
					{ name: 'Unknown', value: 'unknown' },
				],
				default: 'fullreport',
				displayOptions: { show: { operation: ['bulkGetFile'] } },
				description: 'Which report to download',
			},
			{
				displayName: 'Output',
				name: 'output',
				type: 'options',
				options: [
					{
						name: 'Emails',
						value: 'emails',
						description: 'Return one item per email from the report',
					},
					{
						name: 'File',
						value: 'file',
						description: 'Return the raw CSV report as binary data',
					},
				],
				default: 'emails',
				displayOptions: { show: { operation: ['bulkGetFile'] } },
				description: 'How the downloaded report is returned',
			},
			{
				displayName: 'Remove Duplicate Emails',
				name: 'removeDuplicates',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['bulkGetFile'], output: ['emails'] } },
				description: 'Whether to drop duplicate email addresses from the returned records',
			},
			{
				displayName: 'Include File',
				name: 'includeFile',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['bulkGetFile'], output: ['emails'] } },
				description:
					'Whether to also attach the downloaded CSV as binary data, so it can be viewed and downloaded from the node output',
			},
			{
				displayName: 'Output Filename',
				name: 'outputFilename',
				type: 'string',
				default: '',
				placeholder: 'n8n_validation_processed.csv',
				displayOptions: { show: { operation: ['bulkGetFile'] } },
				description:
					'Optional name for the downloaded file. Defaults to the name the API served it under.',
			},
			{
				displayName: 'Output Binary Field',
				name: 'outputBinaryProperty',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { operation: ['bulkGetFile'] } },
				description:
					'The binary property to write the downloaded CSV report to, used by the File output and by Include File',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		const client = new QuickEmailVerificationClient(this);

		for (let i = 0; i < items.length; i++) {
			try {
				if (operation === 'verifyEmail') {
					const email = this.getNodeParameter('email', i) as string;
					const verification = await client.verify(email);
					results.push({
						json: verification as unknown as IDataObject,
						pairedItem: { item: i },
					});
					continue;
				}

				if (operation === 'bulkSendFile') {
					results.push(...(await sendFile(this, client, i)));
					continue;
				}

				if (operation === 'bulkFileStatus') {
					results.push({ json: await fileStatus(this, client, i), pairedItem: { item: i } });
					continue;
				}

				if (operation === 'bulkGetFile') {
					results.push(...(await getFile(this, client, i)));
					continue;
				}

				if (operation === 'bulkDeleteFile') {
					results.push({ json: await deleteFile(this, client, i), pairedItem: { item: i } });
					continue;
				}

				throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
					itemIndex: i,
				});
			} catch (error) {
				if (this.continueOnFail()) {
					results.push({
						json: { success: false, message: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [results];
	}
}

/*
 * The bulk operations are standalone functions because within `execute` the
 * node's `this` is bound to the execution context (IExecuteFunctions), not the
 * class instance.
 */

/**
 * Upload one email list and return immediately with the accepted file details.
 * The node does not wait for verification: use List Verification File Status and
 * then List Verification Get File (or a return URL) to collect the report.
 */
async function sendFile(
	ctx: IExecuteFunctions,
	client: QuickEmailVerificationClient,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const inputType = ctx.getNodeParameter('inputType', itemIndex, InputType.FILE) as string;
	let filename = (ctx.getNodeParameter('filename', itemIndex, '') as string).trim();

	// 1. Resolve the file to upload, either an existing one or a CSV built here
	let file: Buffer;
	let itemCount: number | undefined;
	let generatedFile: IBinaryData | undefined;

	if (inputType === InputType.ITEMS) {
		const combineItems = ctx.getNodeParameter('combineItems', itemIndex, true) as boolean;
		// Every item goes into one upload, so only the first item does the work
		if (combineItems && itemIndex > 0) {
			return [];
		}

		const emails = combineItems ? collectCombinedEmails(ctx) : collectEmails(ctx, itemIndex);
		file = Buffer.from(buildEmailCsv(emails), 'utf8');
		itemCount = emails.length;
		if (!filename) filename = GENERATED_FILENAME;

		if (ctx.getNodeParameter('includeFile', itemIndex, false) as boolean) {
			generatedFile = await ctx.helpers.prepareBinaryData(file, filename, 'text/csv');
		}
	} else {
		const uploadMethod = ctx.getNodeParameter('uploadMethod', itemIndex, 'binary') as string;
		if (uploadMethod === 'binary') {
			const binaryProperty = ctx.getNodeParameter('binaryProperty', itemIndex, 'data') as string;
			const binary = ctx.helpers.assertBinaryData(itemIndex, binaryProperty);
			file = await ctx.helpers.getBinaryDataBuffer(itemIndex, binaryProperty);
			if (!filename) filename = binary.fileName || 'list.csv';
		} else {
			const filePath = (ctx.getNodeParameter('filePath', itemIndex, '') as string).trim();
			if (!filePath) {
				throw new NodeOperationError(
					ctx.getNode(),
					'File Path is required for the "File Path" upload method',
					{ itemIndex },
				);
			}
			let isFile = false;
			try {
				isFile = (await stat(filePath)).isFile();
			} catch {
				isFile = false;
			}
			if (!isFile) {
				throw new NodeOperationError(ctx.getNode(), `No readable file found at: ${filePath}`, {
					itemIndex,
				});
			}
			file = await readFile(filePath);
			if (!filename) filename = basename(filePath);
		}
	}

	if (!file || file.length === 0) {
		throw new NodeOperationError(ctx.getNode(), 'The email list file is empty', { itemIndex });
	}

	// 2. Upload
	const options: IBulkUploadOptions = {
		filename,
		callbackUrl: (ctx.getNodeParameter('callbackUrl', itemIndex, '') as string).trim() || undefined,
		notificationEmail:
			(ctx.getNodeParameter('notificationEmail', itemIndex, '') as string).trim() || undefined,
	};

	let upload;
	try {
		upload = await client.uploadList(file, options);
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), { message: (error as Error).message } as JsonObject, {
			message: `Email list upload failed: ${(error as Error).message}`,
			itemIndex,
		});
	}

	// 3. Report what was accepted. The API only guarantees the file id, so the
	// name and item count fall back to what was sent.
	const apiCount = Number(upload.item_count ?? upload.count ?? upload.total);

	return [
		{
			json: {
				success: upload.success !== false,
				message: upload.message || 'File Accepted',
				file_name: upload.filename ?? filename,
				file_id: upload.id,
				item_count:
					Number.isFinite(apiCount) && apiCount > 0 ? apiCount : itemCount ?? countListItems(file),
				return_url: options.callbackUrl ?? null,
			},
			binary: generatedFile ? { data: generatedFile } : undefined,
			pairedItem: { item: itemIndex },
		},
	];
}

/** Report the current processing state of a validation file. */
async function fileStatus(
	ctx: IExecuteFunctions,
	client: QuickEmailVerificationClient,
	itemIndex: number,
): Promise<IDataObject> {
	const fileId = readFileId(ctx, itemIndex);
	const status = await fetchStatus(ctx, client, fileId, itemIndex);

	return {
		success: status.success !== false,
		file_id: status.id ?? fileId,
		file_name: status.filename ?? '',
		upload_date: status.created_date ?? null,
		file_status: toFileStatus(status.status),
		complete_percentage: status.stats?.progress ?? null,
		error_reason: status.message || null,
		return_url: null,
		// QuickEmailVerification extras beyond the common status fields
		total_email: status.stats?.total_email ?? null,
		result_counts: status.stats?.result_counts ?? null,
		completed_date: status.completed_date ?? null,
		processing_time: status.processing_time ?? null,
	};
}

/**
 * Download the requested report for a completed file, either as one item per
 * email or as the raw CSV in a binary property.
 */
async function getFile(
	ctx: IExecuteFunctions,
	client: QuickEmailVerificationClient,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const fileId = readFileId(ctx, itemIndex);
	const report = ctx.getNodeParameter('report', itemIndex, 'fullreport') as string;
	const output = ctx.getNodeParameter('output', itemIndex, 'emails') as string;

	const status = await fetchStatus(ctx, client, fileId, itemIndex);

	if ((status.status || '').toLowerCase() !== 'completed') {
		throw new NodeOperationError(
			ctx.getNode(),
			`File ${fileId} is not ready yet (file_status: "${toFileStatus(status.status)}", ` +
				`complete_percentage: ${status.stats?.progress ?? 'n/a'})`,
			{ itemIndex },
		);
	}

	const downloadUrl = status.download_urls?.[report];
	if (!downloadUrl) {
		throw new NodeOperationError(
			ctx.getNode(),
			`The completed file did not provide a download URL for the "${report}" report`,
			{ itemIndex },
		);
	}

	let download;
	try {
		download = await client.download(downloadUrl);
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), { message: (error as Error).message } as JsonObject, {
			message: `Report download failed: ${(error as Error).message}`,
			itemIndex,
		});
	}

	// Prefer the name the API served the report under; otherwise derive one from
	// the uploaded list so the report type stays visible.
	const uploadedName = status.filename ?? `${fileId}.csv`;
	const remoteFileName =
		filenameFromHeaders(download.headers) ??
		`${uploadedName.replace(/\.[^.]+$/, '')}_${report}.csv`;
	const fileName =
		(ctx.getNodeParameter('outputFilename', itemIndex, '') as string).trim() || remoteFileName;

	// Binary data carries the name, extension, mime type and size that the n8n
	// output panel shows next to its View and Download buttons.
	const binaryProperty = ctx.getNodeParameter('outputBinaryProperty', itemIndex, 'data') as string;
	const binaryData = await ctx.helpers.prepareBinaryData(download.body, fileName, 'text/csv');
	const binary = { [binaryProperty]: binaryData };

	const json: IDataObject = {
		success: true,
		file_id: fileId,
		file_name: binaryData.fileName ?? fileName,
		remote_file_name: remoteFileName,
		file_extension: binaryData.fileExtension ?? 'csv',
		mime_type: binaryData.mimeType,
		file_size: download.body.length,
		report,
	};

	if (output === 'file') {
		return [{ json, binary, pairedItem: { item: itemIndex } }];
	}

	const includeFile = ctx.getNodeParameter('includeFile', itemIndex, false) as boolean;
	const removeDuplicates = ctx.getNodeParameter('removeDuplicates', itemIndex, false) as boolean;

	let records = csvToJson(download.body.toString('utf8'));
	if (removeDuplicates) {
		records = dedupeByEmail(records);
	}
	if (records.length === 0) {
		return [
			{
				json: { ...json, message: 'No email records in report' },
				binary: includeFile ? binary : undefined,
				pairedItem: { item: itemIndex },
			},
		];
	}
	return records.map((record, index) => ({
		json: { ...record, file_id: fileId },
		// The file is attached once, to the first item, so it is not duplicated
		binary: includeFile && index === 0 ? binary : undefined,
		pairedItem: { item: itemIndex },
	}));
}

/** Delete a validation file and its reports. */
async function deleteFile(
	ctx: IExecuteFunctions,
	client: QuickEmailVerificationClient,
	itemIndex: number,
): Promise<IDataObject> {
	const fileId = readFileId(ctx, itemIndex);

	// The delete endpoint does not echo the file name, so look it up first.
	// Best-effort only: a failing status check must not block the deletion.
	let fileName = '';
	try {
		fileName = (await client.getStatus(fileId)).filename ?? '';
	} catch {
		fileName = '';
	}

	let deleted;
	try {
		deleted = await client.deleteJob(fileId);
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), { message: (error as Error).message } as JsonObject, {
			message: `Delete failed: ${(error as Error).message}`,
			itemIndex,
		});
	}

	return {
		success: deleted.success !== false,
		message: deleted.message || 'File Deleted',
		file_name: fileName,
		file_id: deleted.id ?? fileId,
	};
}

/** Read and validate the File ID parameter. */
function readFileId(ctx: IExecuteFunctions, itemIndex: number): string {
	const fileId = (ctx.getNodeParameter('fileId', itemIndex, '') as string).trim();
	if (!fileId) {
		throw new NodeOperationError(ctx.getNode(), 'File ID is required', { itemIndex });
	}
	return fileId;
}

/** Fetch a job status, surfacing API failures as node errors. */
async function fetchStatus(
	ctx: IExecuteFunctions,
	client: QuickEmailVerificationClient,
	fileId: string,
	itemIndex: number,
): Promise<IBulkStatus> {
	try {
		return await client.getStatus(fileId);
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), { message: (error as Error).message } as JsonObject, {
			message: `Status check failed: ${(error as Error).message}`,
			itemIndex,
		});
	}
}
