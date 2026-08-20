import Icon from "./Icon";

const STATE_CLASS = {
  pending: "state-pending",
  active: "state-active",
  done: "state-done",
  failed: "state-failed",
};

export default function NodeBox({ title, subtitle, icon, activity, pct = 0, state = "pending",
  highlight = false, onInfoClick, hidden = false, compact = false }) {
  if (hidden) return null;
  return (
    <div className={`node-box ${compact ? "node-box-compact" : ""} ${highlight ? "node-highlight" : STATE_CLASS[state] || "state-pending"}`}>
      <button className="node-info-btn" onClick={onInfoClick} aria-label={`${title} details`}>
        <Icon name="info" size={14} />
      </button>
      <div className="node-icon"><Icon name={icon || "rocket"} size={20} /></div>
      <div className="node-title">{title}</div>
      {subtitle && <div className="node-subtitle">{subtitle}</div>}
      {activity && <div className="node-activity">{activity}</div>}
      {state === "active" && (
        <div className="node-progress-track">
          <div className="node-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
