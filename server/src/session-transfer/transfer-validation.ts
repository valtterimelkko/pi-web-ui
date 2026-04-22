import { z } from 'zod';
import { TRANSFER_ERROR_CODES, VISIBLE_TOOL_NAMES, type TransferScope, type TransferErrorCode } from './types.js';
import type { SdkType } from '@pi-web-ui/shared';

export interface ValidationResult {
  valid: boolean;
  errorCode?: TransferErrorCode;
  message?: string;
}

const transferScopeSchema = z.enum(['visible_recent', 'visible_full']);
const sdkTypeSchema = z.enum(['pi', 'claude', 'opencode']);

export function validateTransferScope(scope: unknown): scope is TransferScope {
  return transferScopeSchema.safeParse(scope).success;
}

export function validateSdkType(sdkType: unknown): sdkType is SdkType {
  return sdkTypeSchema.safeParse(sdkType).success;
}

export function validateTransferRequest(data: unknown): ValidationResult {
  if (typeof data !== 'object' || data === null) {
    return {
      valid: false,
      errorCode: TRANSFER_ERROR_CODES.INVALID_REQUEST,
      message: 'Request must be an object',
    };
  }

  const req = data as Record<string, unknown>;

  if (typeof req.sourceSessionId !== 'string' || !req.sourceSessionId.trim()) {
    return {
      valid: false,
      errorCode: TRANSFER_ERROR_CODES.INVALID_REQUEST,
      message: 'sourceSessionId is required and must be a non-empty string',
    };
  }

  if (!validateTransferScope(req.scope)) {
    return {
      valid: false,
      errorCode: TRANSFER_ERROR_CODES.INVALID_SCOPE,
      message: `scope must be 'visible_recent' or 'visible_full', got: ${req.scope}`,
    };
  }

  if (req.createNew === true) {
    if (!validateSdkType(req.targetSdkType)) {
      return {
        valid: false,
        errorCode: TRANSFER_ERROR_CODES.INVALID_REQUEST,
        message: 'targetSdkType is required when createNew is true',
      };
    }
    if (typeof req.targetCwd !== 'string' || !req.targetCwd.trim()) {
      return {
        valid: false,
        errorCode: TRANSFER_ERROR_CODES.INVALID_REQUEST,
        message: 'targetCwd is required when createNew is true',
      };
    }
  } else {
    if (typeof req.targetSessionId !== 'string' || !req.targetSessionId.trim()) {
      return {
        valid: false,
        errorCode: TRANSFER_ERROR_CODES.INVALID_REQUEST,
        message: 'targetSessionId is required when not creating a new session',
      };
    }
  }

  if (req.sourceSessionId === req.targetSessionId) {
    return {
      valid: false,
      errorCode: TRANSFER_ERROR_CODES.SELF_TRANSFER,
      message: 'Cannot transfer a session into itself',
    };
  }

  if (req.sourceDisplayName !== undefined && typeof req.sourceDisplayName !== 'string') {
    return {
      valid: false,
      errorCode: TRANSFER_ERROR_CODES.INVALID_REQUEST,
      message: 'sourceDisplayName must be a string if provided',
    };
  }

  if (req.sourceDisplayName !== undefined && req.sourceDisplayName.length > 200) {
    return {
      valid: false,
      errorCode: TRANSFER_ERROR_CODES.INVALID_REQUEST,
      message: 'sourceDisplayName must be at most 200 characters',
    };
  }

  return { valid: true };
}

export function isToolVisible(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  for (const visible of VISIBLE_TOOL_NAMES) {
    if (lower === visible || lower.endsWith(`_${visible}`) || lower.startsWith(`${visible}_`)) {
      return true;
    }
  }
  return false;
}

export function extractToolPrimaryArg(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;

  const lower = toolName.toLowerCase();

  for (const [prefix, argKey] of Object.entries({
    read: 'filePath',
    write: 'filePath',
    edit: 'filePath',
    bash: 'command',
    glob: 'pattern',
    grep: 'pattern',
    webfetch: 'url',
    skill: 'name',
    task: 'description',
  })) {
    if (lower === prefix || lower.endsWith(`_${prefix}`) || lower.startsWith(`${prefix}_`)) {
      const record = args as Record<string, unknown>;
      const value = record[argKey];
      if (typeof value === 'string') {
        return value.length > 100 ? value.slice(0, 100) + '...' : value;
      }
    }
  }

  return undefined;
}
