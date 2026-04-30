import { useState } from 'react';
import type { DriveModeModel } from '../../store/driveModeStore';
import { DRIVE_MODE_MODELS } from './driveModeModels';

export interface DriveModeModelPickerProps {
  onSelect: (model: DriveModeModel) => void;
  onBack: () => void;
}

export function DriveModeModelPicker({ onSelect, onBack }: DriveModeModelPickerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedModel = DRIVE_MODE_MODELS.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="flex flex-col items-center h-full w-full px-4 py-6">
      <h2 className="text-xl font-semibold text-center text-gray-900 dark:text-gray-100 mb-6">
        Choose a Model
      </h2>

      <div className="w-full max-w-[90%] flex flex-col gap-3">
        {DRIVE_MODE_MODELS.map((model) => {
          const isSelected = selectedId === model.id;
          return (
            <button
              key={model.id}
              onClick={() => setSelectedId(model.id)}
              className={`w-full rounded-xl border-2 p-4 cursor-pointer transition-colors text-left flex items-center gap-3 ${
                isSelected
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                  : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
              type="button"
            >
              <span className="text-lg font-medium text-gray-900 dark:text-gray-100 flex-1">
                {model.displayName}
              </span>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  model.sdkType === 'pi'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                }`}
              >
                {model.sdkType === 'pi' ? 'Pi' : 'OC'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-auto pt-6 w-full max-w-[90%] flex items-center justify-between">
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          type="button"
        >
          Back
        </button>
        <button
          onClick={() => {
            if (selectedModel) {
              onSelect(selectedModel);
            }
          }}
          disabled={!selectedModel}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            selectedModel
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500'
          }`}
          type="button"
        >
          Create Session
        </button>
      </div>
    </div>
  );
}
