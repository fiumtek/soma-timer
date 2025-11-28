let timerInterval = null;
let totalSeconds = 0;
let remainingSeconds = 0;
let isRunning = false;
let isPaused = false;

const timerDisplay = document.getElementById('timerDisplay');
const meditationCircle = document.getElementById('meditationCircle');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const timeButtons = document.querySelectorAll('.time-btn');

// 시간 선택 버튼 이벤트
timeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (isRunning) return;
        
        timeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const minutes = parseInt(btn.dataset.minutes);
        totalSeconds = minutes * 60;
        remainingSeconds = totalSeconds;
        updateDisplay();
    });
});

// 시작 버튼
startBtn.addEventListener('click', () => {
    if (totalSeconds === 0) return;
    
    if (isPaused) {
        // 일시정지 상태에서 재개
        isPaused = false;
        isRunning = true;
        startBtn.style.display = 'none';
        pauseBtn.style.display = 'inline-block';
        meditationCircle.classList.add('active');
        startTimer();
    } else {
        // 새로 시작
        isRunning = true;
        startBtn.style.display = 'none';
        pauseBtn.style.display = 'inline-block';
        meditationCircle.classList.add('active');
        startTimer();
    }
});

// 일시정지 버튼
pauseBtn.addEventListener('click', () => {
    isRunning = false;
    isPaused = true;
    startBtn.style.display = 'inline-block';
    pauseBtn.style.display = 'none';
    meditationCircle.classList.remove('active');
    clearInterval(timerInterval);
});

// 리셋 버튼
resetBtn.addEventListener('click', () => {
    isRunning = false;
    isPaused = false;
    remainingSeconds = totalSeconds;
    startBtn.style.display = 'inline-block';
    pauseBtn.style.display = 'none';
    meditationCircle.classList.remove('active');
    clearInterval(timerInterval);
    updateDisplay();
});

// 타이머 시작
function startTimer() {
    timerInterval = setInterval(() => {
        remainingSeconds--;
        updateDisplay();
        
        if (remainingSeconds <= 0) {
            clearInterval(timerInterval);
            timerComplete();
        }
    }, 1000);
}

// 디스플레이 업데이트
function updateDisplay() {
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    timerDisplay.textContent = 
        `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// 타이머 완료
function timerComplete() {
    isRunning = false;
    isPaused = false;
    startBtn.style.display = 'inline-block';
    pauseBtn.style.display = 'none';
    meditationCircle.classList.remove('active');
    
    // 부드러운 알림 소리 재생
    playNotificationSound();
    
    // 화면 깜빡임 효과
    document.body.classList.add('flash');
    meditationCircle.classList.add('pulse');
    
    setTimeout(() => {
        document.body.classList.remove('flash');
        meditationCircle.classList.remove('pulse');
    }, 3000);
    
    // 알림 메시지
    timerDisplay.textContent = '완료';
    setTimeout(() => {
        timerDisplay.textContent = '00:00';
    }, 2000);
}

// 알림 소리 재생
function playNotificationSound() {
    // Web Audio API를 사용하여 부드러운 알림 소리 생성
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // 부드러운 벨 소리
    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(400, audioContext.currentTime + 0.5);
    
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
}

