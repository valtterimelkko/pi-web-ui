import { useState, useEffect } from 'react';
import { X, FileText, AlertCircle } from 'lucide-react';
import { api } from '../../lib/api';

interface FilePreviewProps {
  path: string;
  onClose: () => void;
}

export function FilePreview({ path, onClose }: FilePreviewProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

interface ReadResponse {
  content: string;
  truncated: boolean;
}

  useEffect(() => {
    const loadFile = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await api.get(`/files/read?path=${encodeURIComponent(path)}`) as ReadResponse;
        setContent(response.content);
        setTruncated(response.truncated);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file');
      } finally {
        setLoading(false);
      }
    };

    loadFile();
  }, [path]);

  const fileName = path.split('/').pop() || path;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-3xl mx-4 h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-violet-400" />
            <h3 className="text-lg font-semibold text-slate-200">{fileName}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin w-6 h-6 border-2 border-violet-600 border-t-transparent rounded-full" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
              <p className="text-red-400">{error}</p>
            </div>
          ) : (
            <div>
              <pre className="text-sm font-mono text-slate-300 whitespace-pre-wrap">
                {content}
              </pre>
              {truncated && (
                <p className="mt-4 text-amber-400 text-sm">
                  ⚠️ File was truncated (50KB limit)
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-800 text-sm text-slate-500">
          {path}
        </div>
      </div>
    </div>
  );
}
