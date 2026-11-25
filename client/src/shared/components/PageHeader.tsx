import type { ReactElement, ReactNode } from 'react';

interface Props {
  // 상단 메뉴에서의 위치 (예: 'Monitoring · Daily Monitoring') — 메뉴 라벨과 같은 영문을 써서 어디서 왔는지 바로 연결되게 한다
  section: string;
  title: string;
  description?: ReactNode;
  // 오른쪽에 붙는 화면 대표 액션 (예: 추가 버튼)
  actions?: ReactNode;
}

// 모든 화면 공통 제목 영역: 위치 표시 + 제목 + 한 줄 설명, 오른쪽에 대표 액션.
export function PageHeader({ section, title, description, actions }: Props): ReactElement {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <div className="page-header-eyebrow">{section}</div>
        <h2 className="page-title">{title}</h2>
        {description && <p className="page-header-desc">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
