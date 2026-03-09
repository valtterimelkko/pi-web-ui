import { useState, useEffect } from 'react';
import { AlertCircle, Check, X } from 'lucide-react';

export interface ExtensionUIRequest {
  id: string;
  type: 'confirm' | 'select' | 'input' | 'editor';
  method: string;
  params: Record<string, unknown>;
  timeout: number;
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
}

export function ExtensionDialog({ request, onResponse }: ExtensionDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const [selectedValue, setSelectedValue] = useState<unknown>(null);

  // Reset state when request changes
  useEffect(() => {
    setInputValue('');
    setSelectedValue(null);
  }, [request?.id]);

  if (!request) return null;

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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-slate-800">
          <AlertCircle className="w-6 h-6 text-violet-400" />
          <h3 className="text-lg font-semibold text-slate-100">
            Extension Request
          </h3>
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
        <div className="flex justify-end gap-2 p-4 border-t border-slate-800">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
          {request.type === 'confirm' && (
            <>
              <button
                onClick={handleReject}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
              >
                <X className="w-4 h-4 inline mr-1" />
                No
              </button>
              <button
                onClick={handleApprove}
                className="px-4 py-2 bg-violet-600 hover:bg-violet-700 rounded-lg transition-colors"
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
              className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-700 disabled:cursor-not-allowed rounded-lg transition-colors"
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
      <p className="text-slate-300">{params.message as string}</p>
      {!!params.details && (
        <pre className="mt-3 p-3 bg-slate-800 rounded text-sm text-slate-400 overflow-auto max-h-40">
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
      <p className="text-slate-300 mb-3">{params.message as string}</p>
      {options.map((option) => (
        <button
          key={String(option.value)}
          onClick={() => onChange(option.value)}
          className={`
            w-full p-3 rounded-lg text-left transition-colors
            ${value === option.value
              ? 'bg-violet-600/30 border border-violet-600'
              : 'bg-slate-800 hover:bg-slate-700 border border-transparent'
            }
          `}
        >
          <span className="text-slate-200">{String(option.label)}</span>
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
      <label className="block text-sm text-slate-400 mb-2">
        {params.label as string}
      </label>
      <input
        type={params.password ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={params.placeholder as string}
        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-600"
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
      <label className="block text-sm text-slate-400 mb-2">
        {params.label as string}
      </label>
      <textarea
        value={value || (params.defaultValue as string) || ''}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-600 resize-none"
      />
    </div>
  );
}
