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
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl border border-gray-200 w-full max-w-md mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-gray-200">
          <AlertCircle className="w-6 h-6 text-blue-600" />
          <h3 className="text-lg font-semibold text-gray-900">
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
      <p className="text-gray-700">{params.message as string}</p>
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
