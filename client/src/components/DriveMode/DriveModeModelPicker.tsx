import type { DriveModeModel } from '../../store/driveModeStore';
import { DRIVE_MODE_MODELS } from './driveModeModels';

export interface DriveModeModelPickerProps {
  onSelect: (model: DriveModeModel) => void;
  onBack: () => void;
}

export function DriveModeModelPicker({ onSelect, onBack }: DriveModeModelPickerProps) {
  return (
    <div className="flex flex-col items-center h-full w-full px-4 py-6">
      <h2 className="text-xl font-semibold text-center text-gray-900 dark:text-gray-100 mb-6">
        Choose a Model
      </h2>

      <div className="w-full max-w-[90%] flex flex-col gap-3">
        {DRIVE_MODE_MODELS.map((model) => (
          <button
            key={model.id}
            onClick={() => onSelect(model)}
            className="w-full rounded-xl border-2 border-gray-200 dark:border-gray-700 p-4 cursor-pointer transition-colors text-left flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-gray-800 active:scale-[0.98] select-none touch-manipulation"
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
        ))}
      </div>

      <div className="mt-auto pt-6 w-full max-w-[90%] flex items-center justify-center">
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          type="button"
        >
          Back
        </button>
      </div>
    </div>
  );
}
