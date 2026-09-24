import { SquareStatus } from '@human-bingo/domain';

const statusRows = [
  { status: SquareStatus.Unverified, label: 'Open', icon: '○' },
  { status: SquareStatus.Pending, label: 'Waiting', icon: '◌' },
  { status: SquareStatus.Rejected, label: 'Try again', icon: '×' },
  { status: SquareStatus.Verified, label: 'Stamped', icon: '✓' },
] as const;

export function StatusLegend() {
  return (
    <ul className="status-legend" aria-label="Square status key">
      {statusRows.map((item) => (
        <li
          className={`status-token status-token--${item.status}`}
          key={item.status}
          data-status={item.status}
        >
          <span className="status-token__icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
