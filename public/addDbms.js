// DOMContentLoaded 이벤트가 발생하면 실행되는 콜백 함수입니다.
document.addEventListener('DOMContentLoaded', function () {
    // 'add-dbms' 아이디를 가진 폼 엘리먼트를 가져옵니다.
    const addDbms = document.getElementById('add-dbms');

    // 폼에 submit 이벤트 리스너를 추가합니다.
    addDbms.addEventListener('submit', function (event) {
        // 기본 폼 제출 동작을 막습니다.
        event.preventDefault();

        // FormData를 사용하여 폼 데이터를 가져옵니다.
        const formData = new FormData(this);

        // 서버에 POST 요청을 보내기 위한 fetch 함수를 사용합니다.
        fetch('http://localhost:3000/dbms', {
            method: 'POST', // HTTP 메서드는 POST입니다.
            headers: {
                'Content-Type': 'application/json', // 요청 본문의 형식은 JSON입니다.
            },
            // FormData를 JSON 형식으로 변환하여 요청 본문에 추가합니다.
            body: JSON.stringify(Object.fromEntries(formData)),
        })
        // 서버 응답을 JSON 형식으로 파싱합니다.
        .then(response => response.json())
        .then(dbms => {
            // 서버에서 반환한 게시글 정보를 콘솔에 출력합니다.
            console.log('게시글이 생성되었습니다:', dbms);

            // 게시글이 생성된 후에 main.html로 리디렉션합니다.
            window.location.href = 'http://localhost:3000/';
        })
        .catch(error => {
            // 오류가 발생하면 콘솔에 오류 메시지를 출력합니다.
            console.error('게시글 생성 중 오류 발생:', error);
        });
    });
});