import {
  Cell, Pie, PieChart, ResponsiveContainer, Tooltip,
} from "recharts";
import type { StatusBucket } from "../types";
import { useLanguage } from "../hooks/useLanguage";

interface DonutCardProps {
  buckets: StatusBucket[];
  onSegmentClick: (status: string) => void;
  returnToServiceToday?: number;
}

export function formatRuntime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}

interface TooltipPayload {
  payload: StatusBucket;
}

function CustomTooltip({ active, payload, runtimeLabel }: {
  active?: boolean; payload?: TooltipPayload[]; runtimeLabel: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const b = payload[0].payload;
  return (
    <div className="solid-panel p-4 text-sm" style={{ minWidth: 220 }}>
      <div className="font-semibold mb-2" style={{ color: b.color }}>
        {b.status}
      </div>
      <div className="space-y-1 mb-3">
        {(["Sev0", "Sev1", "Sev2", "Sev3", "Sev4", "Sev5"] as const).map((p) => (
          <div key={p} className="flex justify-between">
            <span className="opacity-70">{p}</span>
            <span>{b.prioBreakdown[p]}</span>
          </div>
        ))}
      </div>
      <div className="divider-t pt-2 flex justify-between">
        <span className="opacity-70">{runtimeLabel}</span>
        <span className="font-medium">{formatRuntime(b.totalRuntimeSeconds)}</span>
      </div>
    </div>
  );
}

export function DonutCard({ buckets, onSegmentClick, returnToServiceToday }: DonutCardProps) {
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const { t } = useLanguage();

  return (
    <div className="glass p-6 relative">
      <div style={{ width: "100%", height: 320, position: "relative" }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={buckets}
              dataKey="count"
              nameKey="status"
              innerRadius={100}
              outerRadius={140}
              paddingAngle={2}
              onClick={(d) => onSegmentClick((d as unknown as StatusBucket).status)}
              stroke="none"
            >
              {buckets.map((b) => (
                <Cell key={b.status} fill={b.color} cursor="pointer" />
              ))}
            </Pie>
            <Tooltip
              content={<CustomTooltip runtimeLabel={t("donut.totalRuntime")} />}
              wrapperStyle={{ zIndex: 50, pointerEvents: "none" }}
            />
          </PieChart>
        </ResponsiveContainer>

        <div
          className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
          style={{ zIndex: 1 }}
        >
          <div className="text-5xl font-light leading-none">{total}</div>
          <div className="text-xs uppercase tracking-widest opacity-60 mt-1 leading-tight">
            {t("donut.active")}
          </div>
          <div className="flex gap-2 mt-2 text-sm font-medium leading-tight">
            {buckets.map((b, i) => (
              <span key={b.status} className="flex items-center gap-2">
                <span style={{ color: b.color }}>{b.count}</span>
                {i < buckets.length - 1 ? <span className="opacity-40">/</span> : null}
              </span>
            ))}
          </div>
          {returnToServiceToday !== undefined && (
            <div
              className="mt-1.5 text-xs flex items-center gap-1.5 leading-tight"
              title={t("donut.rtsTodayFull")}
            >
              <span style={{ color: "#34D399" }}>✓</span>
              <span style={{ color: "#34D399" }} className="font-medium">
                {returnToServiceToday}
              </span>
              <span className="opacity-50">{t("donut.rtsTodayShort")}</span>
            </div>
          )}
        </div>
      </div>

      <p className="text-xs opacity-50 mt-4 text-center">
        {t("donut.hint")}
      </p>
    </div>
  );
}
