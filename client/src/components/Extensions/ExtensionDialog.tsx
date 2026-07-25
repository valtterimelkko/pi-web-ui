import { useState, useEffect } from 'react';
import { AlertCircle, Check, X } from 'lucide-react';
import {
  AskUserQuestionDialog,
  type AskUserQuestion,
} from './AskUserQuestionDialog';

export interface ExtensionUIRequest {
  id: string;
  type: 'confirm' | 'select' | 'input' | 'editor' | 'ask_user_question';
  method: string;
  params: Record<string, unknown>;
  timeout: number;
  /** Epoch ms the request arrived (for computing the near-expiry deadline). */
  receivedAt?: number;
  /** Set when the server signalled the dialog closed (extension_ui_cancel). */
  expired?: boolean;
  /** Why the dialog closed ('timeout' | 'aborted' | 'turn_end' | 'disconnected'). */
  expiredReason?: string;
}

export interface ExtensionUIResponse {
  id: string;
  approved?: boolean;
  value?: unknown;
  cancelled?: boolean;
}

interface ExtensionDialogProps {
  request: ExtensionUIRequest | null;
  onResponse: (response: ExtensionUIResponse) => void;
  /** Dismiss an expired AskUserQuestion dialog (clears it; no server round-trip). */
  onDismiss?: () => void;
}

export function ExtensionDialog({ request, onResponse, onDismiss }: ExtensionDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const [selectedValue, setSelectedValue] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setInputValue('');
    setSelectedValue(null);
  }, [request?.id]);

  // A dialog that sits open past its request deadline is answering a question
  // the runtime has already given up on, so show the remaining time.
  const deadline = request && typeof request.receivedAt === 'number' && typeof request.timeout === 'number'
    ? request.receivedAt + request.timeout
    : null;
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  if (!request) return null;

  // AskUserQuestion has its own dedicated dialog (1–4 questions, multi-select,
  // previews). Delegate to it instead of the legacy confirm/select chrome.
  if (request.type === 'ask_user_question') {
    const questions = (request.params.questions ?? []) as AskUserQuestion[];
    // Absolute deadline from the stamped arrival time + the server's timeout.
    const expiresAt =
      typeof request.receivedAt === 'number' && typeof request.timeout === 'number'
        ? request.receivedAt + request.timeout
        : undefined;
    return (
      <AskUserQuestionDialog
        questions={questions}
        expiresAt={expiresAt}
        expired={request.expired}
        expiredReason={request.expiredReason}
        onDismissExpired={onDismiss}
        onSubmit={(value) => onResponse({ id: request.id, approved: true, value })}
        onCancel={() => onResponse({ id: request.id, cancelled: true })}
      />
    );
  }

  const handleApprove = () => {
    onResponse({
      id: request.id,
      approved: true,
      value: selectedValue || inputValue || true,
    });
  };

  const handleReject = () => {
    onResponse({
      id: request.id,
      approved: false,
    });
  };

  const handleCancel = () => {
    onResponse({
      id: request.id,
      cancelled: true,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl border border-gray-200 w-full max-w-md mx-4 shadow-xl">
        {/* Header — the extension's own title, not a generic label */}
        <div className="flex items-center gap-3 p-4 border-b border-gray-200">
          <AlertCircle className="w-6 h-6 flex-shrink-0 text-blue-600" />
          <h3 className="text-lg font-semibold text-gray-900 min-w-0 break-words" data-testid="extension-dialog-title">
            {typeof request.params.title === 'string' && request.params.title.trim()
              ? request.params.title
              : 'Extension Request'}
          </h3>
          {deadline !== null && (
            <span className="ml-auto flex-shrink-0 text-xs text-gray-400" data-testid="extension-dialog-expiry">
              {Math.max(0, Math.ceil((deadline - now) / 1000))}s
            </span>
          )}
        </div>

        {/* Content */}
        <div className="p-4">
          {request.type === 'confirm' && (
            <ConfirmContent params={request.params} />
          )}
          {request.type === 'select' && (
            <SelectContent
              params={request.params}
              value={selectedValue}
              onChange={setSelectedValue}
            />
          )}
          {request.type === 'input' && (
            <InputContent
              params={request.params}
              value={inputValue}
              onChange={setInputValue}
            />
          )}
          {request.type === 'editor' && (
            <EditorContent
              params={request.params}
              value={inputValue}
              onChange={setInputValue}
            />
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 p-4 border-t border-gray-200">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-gray-500 hover:text-gray-700 transition-colors"
          >
            Cancel
          </button>
          {request.type === 'confirm' && (
            <>
              <button
                onClick={handleReject}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors text-gray-700"
              >
                <X className="w-4 h-4 inline mr-1" />
                No
              </button>
              <button
                onClick={handleApprove}
                className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors"
              >
                <Check className="w-4 h-4 inline mr-1" />
                Yes
              </button>
            </>
          )}
          {(request.type === 'select' || request.type === 'input' || request.type === 'editor') && (
            <button
              onClick={handleApprove}
              disabled={!selectedValue && !inputValue}
              className="px-4 py-2 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
            >
              <Check className="w-4 h-4 inline mr-1" />
              Confirm
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Sub-components
function ConfirmContent({ params }: { params: Record<string, unknown> }) {
  return (
    <div>
      <p
        className="text-gray-700 whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto"
        data-testid="extension-dialog-message"
      >
        {params.message as string}
      </p>
      {!!params.details && (
        <pre className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded text-sm text-gray-600 overflow-auto max-h-40">
          {JSON.stringify(params.details, null, 2)}
        </pre>
      )}
    </div>
  );
}

function SelectContent({
  params,
  value,
  onChange,
}: {
  params: Record<string, unknown>;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const options = params.options as Array<{ label: string; value: unknown }> || [];

  return (
    <div className="space-y-2">
      <p className="text-gray-700 mb-3">{params.message as string}</p>
      {options.map((option) => (
        <button
          key={String(option.value)}
          onClick={() => onChange(option.value)}
          className={`
            w-full p-3 rounded-lg text-left transition-colors
            ${value === option.value
              ? 'bg-blue-50 border border-blue-500'
              : 'bg-gray-50 hover:bg-gray-100 border border-gray-200'
            }
          `}
        >
          <span className="text-gray-900">{String(option.label)}</span>
        </button>
      ))}
    </div>
  );
}

function InputContent({
  params,
  value,
  onChange,
}: {
  params: Record<string, unknown>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm text-gray-500 mb-2">
        {params.label as string}
      </label>
      <input
        type={params.password ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={params.placeholder as string}
        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

function EditorContent({
  params,
  value,
  onChange,
}: {
  params: Record<string, unknown>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm text-gray-500 mb-2">
        {params.label as string}
      </label>
      <textarea
        value={value || (params.defaultValue as string) || ''}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
      />
    </div>
  );
}
