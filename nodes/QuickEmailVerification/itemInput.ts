import type {
	AssignmentCollectionValue,
	IDataObject,
	IExecuteFunctions,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * The node's single resource. Every operation acts on the same thing — an email
 * address, or a list of them — so they are all grouped under it.
 */
export const RESOURCE = 'emailVerification';

/** Where the list to upload comes from. */
export const InputType = {
	FILE: 'file',
	ITEMS: 'items',
} as const;

/** How the emails are read off the input items. */
export const ItemInputType = {
	ASSIGNMENT: 'assignment',
	JSON: 'json',
	MAPPED: 'mapped',
} as const;

/** Default name for a list built from input items. */
export const GENERATED_FILENAME = 'n8n_validation.csv';

/** Field names an object may use to hold an email address. */
const EMAIL_KEY = /mail/i;

/** One address per token; anything else is rejected so bad input fails loudly. */
const EMAIL_VALUE = /^[^\s@,;]+@[^\s@,;]+$/;

/**
 * Parameters for building the upload from input items instead of a file.
 * Kept here so the node description stays readable.
 */
export const itemInputProperties: INodeProperties[] = [
	{
		displayName: 'Item Input Type',
		name: 'itemInputType',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Field Assignment',
				value: ItemInputType.ASSIGNMENT,
				description: 'Assign fields from input items. Useful when mapping arrays from input items.',
			},
			{
				name: 'JSON Input',
				value: ItemInputType.JSON,
				description: 'Enter JSON to parse as input',
			},
			{
				name: 'Mapped',
				value: ItemInputType.MAPPED,
				description: "Map fields from input items. Useful when 'Combine Items' is enabled.",
			},
		],
		default: 'assignment',
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['bulkSendFile'], inputType: [InputType.ITEMS] },
		},
		description: 'Type of input used to populate the email list',
	},
	{
		displayName: 'Item Input',
		name: 'itemInputAssignment',
		type: 'assignmentCollection',
		default: {},
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['bulkSendFile'],
				inputType: [InputType.ITEMS],
				itemInputType: [ItemInputType.ASSIGNMENT],
			},
		},
	},
	{
		displayName: 'Item Input',
		name: 'itemInputJson',
		type: 'json',
		default: '',
		placeholder: '{ "emails": ["john@example.com", "jane@example.com"] }',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['bulkSendFile'],
				inputType: [InputType.ITEMS],
				itemInputType: [ItemInputType.JSON],
			},
		},
		description: 'JSON holding the email addresses to verify',
	},
	{
		displayName: 'Item Input',
		name: 'itemInputMapped',
		type: 'fixedCollection',
		default: {},
		typeOptions: { multipleValues: true },
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['bulkSendFile'],
				inputType: [InputType.ITEMS],
				itemInputType: [ItemInputType.MAPPED],
			},
		},
		options: [
			{
				displayName: 'Mapped Values',
				name: 'mappedValues',
				values: [
					{
						displayName: 'Email',
						name: 'email',
						type: 'string',
						default: '',
						placeholder: 'name@example.com',
						description: 'An email address to add to the list',
					},
				],
			},
		],
	},
	{
		displayName: 'Combine Items',
		name: 'combineItems',
		type: 'boolean',
		default: true,
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['bulkSendFile'], inputType: [InputType.ITEMS] },
		},
		description:
			'Whether to combine every input item into one uploaded list. Turn this off to upload one list per input item.',
	},
	{
		displayName: 'Include File',
		name: 'includeFile',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['bulkSendFile'], inputType: [InputType.ITEMS] },
		},
		description: 'Whether to also return the generated CSV as binary data',
	},
];

/**
 * Read the email addresses for one input item, following the selected
 * Item Input Type. Duplicates are removed, keeping the first occurrence.
 */
export function collectEmails(ctx: IExecuteFunctions, itemIndex: number): string[] {
	const itemInputType = ctx.getNodeParameter(
		'itemInputType',
		itemIndex,
		ItemInputType.ASSIGNMENT,
	) as string;

	const emails: string[] = [];

	switch (itemInputType) {
		case ItemInputType.ASSIGNMENT: {
			const value = ctx.getNodeParameter('itemInputAssignment', itemIndex, {});
			const assignments = (value as AssignmentCollectionValue)?.assignments;
			if (!Array.isArray(assignments) || assignments.length === 0) {
				throw new NodeOperationError(ctx.getNode(), 'No fields assigned', {
					itemIndex,
					description: 'Add at least one assignment holding an email address',
				});
			}
			for (const assignment of assignments) {
				walk(ctx, itemIndex, assignment?.name ?? '', assignment?.value, emails);
			}
			break;
		}

		case ItemInputType.JSON: {
			const value = ctx.getNodeParameter('itemInputJson', itemIndex, '');
			walk(ctx, itemIndex, '', parseJson(ctx, itemIndex, value), emails);
			break;
		}

		case ItemInputType.MAPPED: {
			const value = ctx.getNodeParameter('itemInputMapped', itemIndex, {}) as IDataObject;
			walk(ctx, itemIndex, 'email', value.mappedValues, emails);
			break;
		}

		default:
			throw new NodeOperationError(ctx.getNode(), `Unsupported item input type: ${itemInputType}`, {
				itemIndex,
			});
	}

	if (emails.length === 0) {
		throw new NodeOperationError(ctx.getNode(), 'No email addresses found in the input', {
			itemIndex,
			description: 'Check the values or mapping — nothing that looks like an email was found',
		});
	}

	return dedupe(emails);
}

/**
 * Read the email addresses of every input item into one list, for when
 * "Combine Items" builds a single upload out of the whole input.
 */
export function collectCombinedEmails(ctx: IExecuteFunctions): string[] {
	const emails: string[] = [];
	const itemCount = ctx.getInputData().length;
	for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
		emails.push(...collectEmails(ctx, itemIndex));
	}
	return dedupe(emails);
}

/** Build the single-column CSV that gets uploaded. */
export function buildEmailCsv(emails: string[]): string {
	return ['email', ...emails.map(escapeCell)].join('\n') + '\n';
}

/** Parse the JSON Input parameter, which n8n hands over as a string. */
function parseJson(ctx: IExecuteFunctions, itemIndex: number, value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}
	if (value.trim() === '') {
		throw new NodeOperationError(ctx.getNode(), 'Item Input is empty', {
			itemIndex,
			description: 'Enter JSON such as { "emails": ["john@example.com"] }',
		});
	}
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Failed to parse Item Input JSON: ${(error as Error).message}`,
			{ itemIndex, description: 'Ensure the value is valid JSON' },
		);
	}
}

/**
 * Walk any assigned/parsed value and collect the email addresses in it.
 * Strings may hold several addresses separated by commas, semicolons, or
 * newlines. Inside objects only fields whose name mentions "mail" are read, so
 * records like `{ email: "a@b.com", name: "A" }` work without the name tripping
 * validation.
 */
function walk(
	ctx: IExecuteFunctions,
	itemIndex: number,
	name: string,
	value: unknown,
	emails: string[],
): void {
	if (value === undefined || value === null || value === '') {
		return;
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			walk(ctx, itemIndex, name, entry, emails);
		}
		return;
	}

	if (typeof value === 'object') {
		const matched = Object.entries(value as IDataObject).filter(([key]) => EMAIL_KEY.test(key));
		if (matched.length === 0) {
			throw new NodeOperationError(ctx.getNode(), `No email field in ${JSON.stringify(value)}`, {
				itemIndex,
				description: 'Objects must contain a field whose name mentions "mail", e.g. "email"',
			});
		}
		for (const [key, entry] of matched) {
			walk(ctx, itemIndex, key, entry, emails);
		}
		return;
	}

	if (typeof value !== 'string') {
		throw new NodeOperationError(
			ctx.getNode(),
			`Invalid email value${name ? ` for "${name}"` : ''}: ${JSON.stringify(value)}`,
			{ itemIndex, description: 'Expected an email address, or a list of them' },
		);
	}

	for (const token of value.split(/[,;\n\r]+/)) {
		const email = token.trim();
		if (email === '') {
			continue;
		}
		if (!EMAIL_VALUE.test(email)) {
			throw new NodeOperationError(
				ctx.getNode(),
				`Invalid email address${name ? ` for "${name}"` : ''}: ${email}`,
				{ itemIndex, description: 'Expected an email address, or a list of them' },
			);
		}
		emails.push(email);
	}
}

/** Drop repeated addresses, case-insensitively, keeping the first occurrence. */
function dedupe(emails: string[]): string[] {
	const seen = new Set<string>();
	return emails.filter((email) => {
		const key = email.toLowerCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/** Quote a CSV cell only when it needs it. */
function escapeCell(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
