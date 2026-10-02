import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import Chart from 'chart.js/auto';
import type { ChartConfiguration, TooltipItem } from 'chart.js';
import type { AshExecution } from '../../shared/lib/types';
import { colorFor, WAIT_CLASS_ORDER } from './waitClasses';

// 산점도의 점 하나 = 끝난 SQL 실행 하나 (MaxGauge의 SQL Elapsed Time 산점도와 같은 방식).
// x = 실행이 끝난 시각(ASH 마지막 샘플), y = 그 실행이 걸린 시간. 오래 걸린 SQL일수록 높이 찍힌다.
export interface ElapsedPoint {
  x: number; // 끝난 시각 (epoch ms, 브라우저 시계 기준으로 환산) — 화면 배치용
  y: number; // 그리는 위치 — 보통 elapsedSec와 같고, 로그 스케일에선 0초를 1초 위치에 놓는다
  elapsedSec: number; // 실제 걸린 시간 (초) — 툴팁은 항상 이 값을 보여준다
  execution: AshExecution;
}

interface Props {
  points: ElapsedPoint[];
  windowMs: number;
  logScale: boolean;
  theme: 'light' | 'dark';
  onPick: (point: ElapsedPoint) => void;
  // 드래그로 영역을 고르면 그 안의 점들을 넘긴다 (점이 하나도 없으면 호출하지 않음).
  onSelect: (points: ElapsedPoint[]) => void;
}

type ScatterChart = Chart<'scatter', ElapsedPoint[]>;

interface DragBox {
  startX: number;
  startY: number;
  x: number;
  y: number;
}

// 이만큼(px) 이상 끌어야 드래그로 본다 — 그보다 작으면 점 클릭으로 처리.
const DRAG_THRESHOLD_PX = 6;

function themeColors(theme: 'light' | 'dark'): { grid: string; tick: string } {
  return theme === 'dark'
    ? { grid: 'rgba(255,255,255,0.08)', tick: '#9ca3af' }
    : { grid: 'rgba(0,0,0,0.07)', tick: '#6b7280' };
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('ko-KR', { hour12: false });
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

// 로그 스케일은 0을 그릴 수 없어서, 시작 직후(0초) 점은 1초 위치에 놓는다.
function displayY(point: ElapsedPoint, logScale: boolean): number {
  return logScale ? Math.max(point.elapsedSec, 1) : point.elapsedSec;
}

function datasetFor(point: ElapsedPoint): string {
  const waitClass = point.execution.topWaitClass;
  return (WAIT_CLASS_ORDER as readonly string[]).includes(waitClass) ? waitClass : 'Other';
}

export function ElapsedScatter({ points, windowMs, logScale, theme, onPick, onSelect }: Props): ReactElement {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ScatterChart | null>(null);
  const [dragBox, setDragBox] = useState<DragBox | null>(null);
  // 드래그가 끝나면 브라우저가 click도 같이 보내므로, 그 click은 점 선택으로 처리하지 않게 막는다.
  const suppressClickRef = useRef(false);
  const callbacksRef = useRef({ onPick, onSelect });
  callbacksRef.current = { onPick, onSelect };

  // 차트는 마운트 시 한 번만 만들고, 데이터/옵션은 아래 effect에서 갱신한다.
  useEffect(() => {
    if (!canvasRef.current) return;
    const colors = themeColors(theme);
    const config: ChartConfiguration<'scatter', ElapsedPoint[]> = {
      type: 'scatter',
      data: {
        datasets: WAIT_CLASS_ORDER.map((cls) => ({
          label: cls,
          data: [],
          backgroundColor: colorFor(cls) + 'cc',
          borderColor: colorFor(cls),
          borderWidth: 1,
          pointRadius: 3.5,
          pointHoverRadius: 6,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        scales: {
          x: {
            type: 'linear',
            grid: { color: colors.grid },
            ticks: { color: colors.tick, maxRotation: 0, font: { size: 10 }, callback: (value) => formatTime(Number(value)) },
          },
          y: {
            type: 'linear',
            beginAtZero: true,
            title: { display: true, text: 'SQL 경과 시간 (초)', color: colors.tick, font: { size: 11 } },
            grid: { color: colors.grid },
            ticks: { color: colors.tick, font: { size: 10 } },
          },
        },
        plugins: {
          legend: { display: false }, // 위쪽 wait class 범례를 공용으로 씀
          tooltip: {
            callbacks: {
              title: (items: TooltipItem<'scatter'>[]) => (items[0] ? formatTime((items[0].raw as ElapsedPoint).x) : ''),
              label: (item: TooltipItem<'scatter'>) => {
                const point = item.raw as ElapsedPoint;
                const execution = point.execution;
                return [
                  `${formatElapsed(point.elapsedSec)} · SQL_ID ${execution.sqlId ?? '-'}`,
                  `SID ${execution.sid},${execution.serial} (${execution.username ?? '-'}) · ${execution.topEvent}`,
                  `${execution.sqlExecStart?.slice(11) ?? ''} ~ ${execution.lastSample.slice(11)}`,
                ];
              },
            },
          },
        },
        onClick: (_event, elements) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          const element = elements[0];
          const chart = chartRef.current;
          if (!element || !chart) return;
          const point = chart.data.datasets[element.datasetIndex].data[element.index];
          if (point) callbacksRef.current.onPick(point);
        },
        onHover: (event, elements) => {
          const target = event.native?.target as HTMLElement | undefined;
          if (target) target.style.cursor = elements.length > 0 ? 'pointer' : 'crosshair';
        },
      },
    };
    const chart = new Chart(canvasRef.current, config);
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
    // 최초 1회만 생성 — 테마/데이터/옵션 변경은 아래 effect가 반영한다.
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const now = Date.now();
    const visible = points.filter((point) => point.x >= now - windowMs);

    chart.data.datasets.forEach((dataset) => {
      dataset.data = visible
        .filter((point) => datasetFor(point) === dataset.label)
        .map((point) => ({ ...point, y: displayY(point, logScale) }));
    });

    const colors = themeColors(theme);
    const scales = chart.options.scales as Record<string, any>;
    scales.x.min = now - windowMs;
    scales.x.max = now;
    scales.x.grid.color = colors.grid;
    scales.x.ticks.color = colors.tick;
    scales.y.type = logScale ? 'logarithmic' : 'linear';
    scales.y.min = logScale ? 1 : 0;
    scales.y.grid.color = colors.grid;
    scales.y.ticks.color = colors.tick;
    scales.y.title.color = colors.tick;
    chart.update('none');
  }, [points, windowMs, logScale, theme]);

  // ── 드래그 영역 선택 ──
  // 누른 뒤의 움직임/놓기는 window에서 받는다. 차트 밖에서 마우스를 놓아도 드래그가 확실히 끝나고
  // (상자가 남지 않고), 포인터를 붙잡지(capture) 않으니 그냥 클릭했을 때의 점 클릭도 그대로 동작한다.
  const dragBoxRef = useRef<DragBox | null>(null);
  const latestRef = useRef({ points, windowMs, logScale });
  latestRef.current = { points, windowMs, logScale };

  function localPosition(clientX: number, clientY: number): { x: number; y: number } {
    const rect = wrapperRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function updateDragBox(next: DragBox | null): void {
    dragBoxRef.current = next;
    setDragBox(next);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const { x, y } = localPosition(event.clientX, event.clientY);
    updateDragBox({ startX: x, startY: y, x, y });
  }

  const dragging = dragBox !== null;
  useEffect(() => {
    if (!dragging) return;

    function handleMove(event: PointerEvent): void {
      const current = dragBoxRef.current;
      if (!current) return;
      updateDragBox({ ...current, ...localPosition(event.clientX, event.clientY) });
    }

    function handleUp(event: PointerEvent): void {
      const current = dragBoxRef.current;
      updateDragBox(null);
      if (!current) return;
      const end = localPosition(event.clientX, event.clientY);
      finishDrag({ ...current, ...end });
    }

    function handleCancel(): void {
      updateDragBox(null);
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
  }, [dragging]);

  function finishDrag(box: DragBox): void {
    if (Math.abs(box.x - box.startX) < DRAG_THRESHOLD_PX && Math.abs(box.y - box.startY) < DRAG_THRESHOLD_PX) return;

    suppressClickRef.current = true;
    // click 이벤트가 안 오는 경우(차트 밖에서 놓음)에도 다음 클릭까지 막히지 않게 바로 풀어 준다.
    window.setTimeout(() => (suppressClickRef.current = false), 0);

    const chart = chartRef.current;
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!chart || !wrapper || !canvas) return;
    // 드래그 좌표(wrapper 기준)를 캔버스 기준으로 바꾼 뒤 축 값으로 환산한다.
    const offsetX = canvas.getBoundingClientRect().left - wrapper.getBoundingClientRect().left;
    const offsetY = canvas.getBoundingClientRect().top - wrapper.getBoundingClientRect().top;
    const xs = [box.startX - offsetX, box.x - offsetX].map((px) => chart.scales.x.getValueForPixel(px) ?? 0);
    const ys = [box.startY - offsetY, box.y - offsetY].map((py) => chart.scales.y.getValueForPixel(py) ?? 0);
    const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
    const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];

    const { points: allPoints, windowMs: currentWindow, logScale: currentLog } = latestRef.current;
    const now = Date.now();
    const selected = allPoints.filter((point) => {
      if (point.x < now - currentWindow) return false;
      const y = displayY(point, currentLog);
      return point.x >= minX && point.x <= maxX && y >= minY && y <= maxY;
    });
    if (selected.length > 0) callbacksRef.current.onSelect(selected);
  }

  const box = dragBox && {
    left: Math.min(dragBox.startX, dragBox.x),
    top: Math.min(dragBox.startY, dragBox.y),
    width: Math.abs(dragBox.x - dragBox.startX),
    height: Math.abs(dragBox.y - dragBox.startY),
  };

  return (
    <div
      ref={wrapperRef}
      className="rt-scatter-area"
      onPointerDown={handlePointerDown}
    >
      <canvas ref={canvasRef} />
      {box && box.width + box.height >= DRAG_THRESHOLD_PX && <div className="rt-drag-box" style={box} />}
    </div>
  );
}
