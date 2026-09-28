import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// DB Cockpit 프론트엔드 전체(멀티 페이지 MPA) 빌드 설정.
//
// - outDir이 Express의 public/ 디렉터리를 직접 가리킨다. emptyOutDir을 켜면
//   아직 이관하지 않은 vanilla 페이지까지 지워지므로 반드시 false로 둔다.
// - Vite는 index.html만 자동 엔트리로 인식하므로, 페이지별 파일명을 rollupOptions.input에
//   전부 명시한다. 출력 파일명도 이 키가 아니라 각 값(html 파일명)을 그대로 따라간다.
// - manualChunks를 함수로 둬서 공유 청크 이름을 완전히 예측 가능하게 고정한다: node_modules는
//   전부 'vendor', client/src/shared 밑의 공용 코드는 전부 'shared', 그 외(페이지 전용 코드)는
//   각자의 엔트리 청크에 남긴다. 객체 형태({vendor:['react','react-dom']})로만 두면 Rollup이
//   페이지 2개 이상이 같이 쓰는 나머지 공용 모듈(우리 shared/ 코드)은 임의의 모듈 이름을 딴
//   청크로 알아서 쪼개버리는데(예: "ToastHost.js" 안에 react-dom 상당수가 같이 들어감),
//   그 임의 이름은 middleware/auth.ts의 로그인 페이지 사전 허용 목록처럼 정확한 파일명을
//   알아야 하는 곳에서 매 빌드마다 달라질 수 있어 위험하다 — 함수형으로 명시해 이름을 고정한다.
// - 산출물 파일명을 해시 없이 고정해서, 다시 빌드할 때마다 새 해시 파일이 쌓이지 않고
//   같은 파일을 덮어쓰게 한다 (내부 도구라 캐시 갱신 지연은 감내 가능).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../public', import.meta.url)),
    emptyOutDir: false,
    // Vite가 자동 주입하는 modulepreload 폴리필 청크를 끈다 — 안 그러면 로그인 페이지 같은
    // 인증 전 페이지가 또 하나의 임의 이름 청크에 의존하게 돼 auth.ts 허용 목록이 늘어난다.
    // 이 앱은 Chrome/Edge 기준(File System Access API 등 이미 씀)이라 폴리필이 불필요하다.
    modulePreload: false,
    rollupOptions: {
      // 페이지는 실제 구현이 끝난 것만 여기 추가한다 — 아직 자리표시자뿐인 페이지를
      // 먼저 추가하면 빌드할 때마다 아직 정상 동작하는 vanilla 버전을 미완성 화면으로
      // 덮어써버리게 된다 (완성된 페이지 → public/*.html로 실제 교체, 그 전까지는 vanilla 유지).
      input: {
        dailyMonitoring: fileURLToPath(new URL('./dailyMonitoring.html', import.meta.url)),
        login: fileURLToPath(new URL('./login.html', import.meta.url)),
        databases: fileURLToPath(new URL('./index.html', import.meta.url)),
        scripts: fileURLToPath(new URL('./monitoringScript.html', import.meta.url)),
        thresholds: fileURLToPath(new URL('./monitoringThresholds.html', import.meta.url)),
        users: fileURLToPath(new URL('./users.html', import.meta.url)),
        history: fileURLToPath(new URL('./history.html', import.meta.url)),
        issues: fileURLToPath(new URL('./issues.html', import.meta.url)),
        tableSpec: fileURLToPath(new URL('./tableSpec.html', import.meta.url)),
        realtime: fileURLToPath(new URL('./realtimeMonitoring.html', import.meta.url)),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
          if (id.includes('/src/shared/')) return 'shared';
          return undefined;
        },
        entryFileNames: 'assets/pages/[name].js',
        chunkFileNames: 'assets/chunks/[name].js',
        assetFileNames: 'assets/pages/[name][extname]',
      },
    },
  },
});
