import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { API_VERSION, USER_AGENT } from '../nodes/QuickEmailVerification/QuickEmailVerificationApi';

/**
 * Credentials for the QuickEmailVerification API.
 * A single API key authenticates every request. It is injected both as an
 * `apikey` query parameter (used by the verify, status, and delete endpoints)
 * and as an `Authorization: token <key>` header (used by the bulk upload
 * endpoint), so a single credential works across all endpoints the node calls.
 */
export class QuickEmailVerificationApi implements ICredentialType {
	name = 'quickEmailVerificationApi';

	displayName = 'QuickEmailVerification API';

	documentationUrl = 'https://docs.quickemailverification.com/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your QuickEmailVerification API key, available from your account dashboard',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			qs: {
				apikey: '={{$credentials.apiKey}}',
			},
			headers: {
				Authorization: '=token {{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * Tested against the sandbox endpoint, which returns a mock result and is
	 * free — no verification credit is spent when the credential is saved or
	 * retested. It still authenticates, answering 401 for a bad key.
	 * `valid@example.com` is one of the documented mock addresses, so no real
	 * mailbox is ever verified.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: `https://api.quickemailverification.com/${API_VERSION}`,
			url: '/verify/sandbox',
			qs: { email: 'valid@example.com' },
			headers: { 'User-Agent': USER_AGENT },
		},
	};
}
