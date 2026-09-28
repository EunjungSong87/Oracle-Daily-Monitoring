import type { ReactElement } from 'react';

// public/common.js의 NAV_ICON_SPRITE를 그대로 이식. nav 아이콘들이 <use href="#ic-xxx">로
// 참조하는 <symbol> 역할의 <g> 정의 모음이며, currentColor를 써서 nav 링크 글자색을 따라간다.
export function NavIconSprite(): ReactElement {
  return (
    <svg
      id="nav-icon-sprite"
      aria-hidden="true"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    >
      <defs>
        <g id="ic-db" fill="none">
          <ellipse cx={8} cy={4.3} rx={5.2} ry={2} stroke="currentColor" strokeWidth={1.3} />
          <path
            d="M2.8 4.3v7.4c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V4.3"
            stroke="currentColor"
            strokeWidth={1.3}
          />
          <path d="M2.8 8c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2" stroke="currentColor" strokeWidth={1.3} />
        </g>
        <g id="ic-pulse" fill="none">
          <path
            d="M1.5 8.4h3l1.4-3.6 2 6.8 1.6-4.6 1.1 1.4h3"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g id="ic-play" fill="none">
          <circle cx={8} cy={8} r={6.3} stroke="currentColor" strokeWidth={1.3} />
          <path d="M6.6 5.4l4 2.6-4 2.6z" fill="currentColor" />
        </g>
        <g id="ic-code" fill="none">
          <path
            d="M5.6 4.2L2 8l3.6 3.8M10.4 4.2L14 8l-3.6 3.8"
            stroke="currentColor"
            strokeWidth={1.35}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g id="ic-gauge" fill="none">
          <path
            d="M3 11 A5.4 5.4 0 1 1 13 11"
            stroke="currentColor"
            strokeWidth={1.3}
            strokeLinecap="round"
            opacity={0.65}
          />
          <line x1={8} y1={9.6} x2={10.8} y2={6} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
          <circle cx={8} cy={9.6} r={1.05} fill="currentColor" />
        </g>
        <g id="ic-history" fill="none">
          <circle cx={8} cy={8.4} r={5.6} stroke="currentColor" strokeWidth={1.3} />
          <path
            d="M8 5.2v3.4l2.4 1.4"
            stroke="currentColor"
            strokeWidth={1.3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2.6 3.6v2.6h2.6"
            stroke="currentColor"
            strokeWidth={1.3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g id="ic-issue" fill="none">
          <path d="M8 2.4l6.2 10.8H1.8z" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
          <line x1={8} y1={6.6} x2={8} y2={9.4} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
          <circle cx={8} cy={11.3} r={0.85} fill="currentColor" />
        </g>
        <g id="ic-wrench" fill="none">
          <path
            d="M10.3 2.7a3 3 0 0 0-3.9 3.8L2 11l2 2 4.5-4.4a3 3 0 0 0 3.8-3.9l-2 2-1.6-.4-.4-1.6z"
            stroke="currentColor"
            strokeWidth={1.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </g>
        <g id="ic-table" fill="none">
          <rect x={2} y={3} width={12} height={10} rx={1.6} stroke="currentColor" strokeWidth={1.3} />
          <line x1={2} y1={6.6} x2={14} y2={6.6} stroke="currentColor" strokeWidth={1.1} />
          <line x1={7.6} y1={6.6} x2={7.6} y2={13} stroke="currentColor" strokeWidth={1.1} />
        </g>
        <g id="ic-user" fill="none">
          <circle cx={8} cy={5.3} r={2.6} stroke="currentColor" strokeWidth={1.3} />
          <path
            d="M2.6 13.2c0-3 2.4-5 5.4-5s5.4 2 5.4 5"
            stroke="currentColor"
            strokeWidth={1.3}
            strokeLinecap="round"
          />
        </g>
        <g id="ic-logout" fill="none">
          <path
            d="M6.4 2.6H3.6a1 1 0 0 0-1 1v8.8a1 1 0 0 0 1 1h2.8"
            stroke="currentColor"
            strokeWidth={1.3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 5.2 12.8 8l-3.3 2.8M12.8 8H6"
            stroke="currentColor"
            strokeWidth={1.3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g id="ic-realtime" fill="none">
          <circle cx={8} cy={8} r={1.4} fill="currentColor" />
          <circle cx={8} cy={8} r={4} stroke="currentColor" strokeWidth={1.2} opacity={0.7} />
          <circle cx={8} cy={8} r={6.6} stroke="currentColor" strokeWidth={1.1} opacity={0.35} />
        </g>
      </defs>
    </svg>
  );
}
