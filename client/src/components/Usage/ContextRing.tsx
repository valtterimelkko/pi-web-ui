interface ContextRingProps {
  percent: number;  // 0-100
  size?: number;    // px, default 20
  showLabel?: boolean;
  label?: string;
}

export function ContextRing({ percent, size = 20, showLabel = false, label }: ContextRingProps) {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (clampedPercent / 100) * circumference;

  // Color based on usage level
  let color = '#3b82f6'; // blue - normal
  if (clampedPercent >= 80) color = '#ef4444'; // red - critical
  else if (clampedPercent >= 60) color = '#f59e0b'; // amber - warning

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
      title={label || `Context: ${Math.round(clampedPercent)}%`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-gray-200 dark:text-gray-700"
        />
        {/* Progress ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
      </svg>
      {showLabel && (
        <span
          className="absolute font-medium"
          style={{ color, fontSize: size < 24 ? '7px' : '9px' }}
        >
          {Math.round(clampedPercent)}
        </span>
      )}
    </div>
  );
}
