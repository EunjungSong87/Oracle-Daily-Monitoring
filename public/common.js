// common.js — 모든 화면에서 공통으로 쓰는 토스트 알림 유틸

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    setTimeout(() => {
        toast.classList.remove('toast-visible');
        setTimeout(() => toast.remove(), 300);
    }, 2600);
}

// 페이지 이동(리로드) 직전에 메시지를 남겨두고, 도착한 페이지에서
// showFlashMessageIfAny()로 꺼내 토스트로 보여줍니다.
function setFlashMessage(message, type = 'success') {
    sessionStorage.setItem('flashMessage', message);
    sessionStorage.setItem('flashType', type);
}

function showFlashMessageIfAny() {
    const message = sessionStorage.getItem('flashMessage');
    if (!message) return;
    const type = sessionStorage.getItem('flashType') || 'success';
    sessionStorage.removeItem('flashMessage');
    sessionStorage.removeItem('flashType');
    showToast(message, type);
}
