
        // Элементы
const questionInput = document.getElementById('questionInput');
const sendButton = document.getElementById('sendButton');
const answersSection = document.getElementById('answersSection');
const loadingIndicator = document.getElementById('loadingIndicator');
const examples = document.querySelectorAll('.example-item');
// ========== РАБОТА С ИСТОРИЕЙ (localStorage) ==========
const STORAGE_KEY = 'chat_history_agu';
let isRequestInProgress = false;
// Загрузить историю при загрузке страницы
// Загрузить историю при загрузке страницы
function loadChatHistory() {
    const saved = localStorage.getItem(STORAGE_KEY);

    // Очищаем всё, но оставляем индикатор загрузки
    while (answersSection.firstChild) {
        if (answersSection.firstChild === loadingIndicator) break;
        answersSection.removeChild(answersSection.firstChild);
    }

    if (saved) {
        try {
            const history = JSON.parse(saved);
            // Добавляем сохранённые ответы (в обратном порядке, чтобы новые были сверху)
            history.reverse().forEach(item => {
                addAnswerToDOM(item.question, item.answer, item.fileName, item.url);
            });
        } catch (e) {
            console.error('Ошибка загрузки истории:', e);
        }
    }

    // Убеждаемся, что индикатор загрузки в конце
    if (answersSection.lastChild !== loadingIndicator) {
        answersSection.appendChild(loadingIndicator);
    }
    loadingIndicator.style.display = 'none';
}

// Сохранить один ответ в историю
function saveAnswerToHistory(question, answer, fileName, url) {
    const saved = localStorage.getItem(STORAGE_KEY);
    let history = saved ? JSON.parse(saved) : [];

    history.unshift({  // новый ответ в начало
        question: question,
        answer: answer,
        fileName: fileName,
        url: url,
        timestamp: Date.now()
    });

    // Ограничим историю 50 последними сообщениями (чтобы не разрасталась)
    if (history.length > 50) history = history.slice(0, 50);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

// Очистить всю историю
function clearChatHistory() {
    localStorage.removeItem(STORAGE_KEY);
    // Оставляем только индикатор загрузки
    answersSection.innerHTML = '';
    answersSection.appendChild(loadingIndicator);
    loadingIndicator.style.display = 'none';
}

// Добавить ответ в DOM (вынесенная логика)
function addAnswerToDOM(question, answer, fileName, url) {
    const newAnswer = document.createElement('div');
    newAnswer.className = 'answer-item';
    newAnswer.innerHTML = `
        <div class="answer-question">${escapeHtml(question)}</div>
        <div class="answer-text">${answer}</div>
        <div class="answer-sources">
            <a class="source-tag" href="${escapeHtml(url)}" target="_blank">${escapeHtml(fileName)}</a>
        </div>
    `;

    // Проверяем, что loadingIndicator является дочерним элементом answersSection
    if (loadingIndicator && answersSection.contains(loadingIndicator)) {
        answersSection.insertBefore(newAnswer, loadingIndicator);
    } else {
        // Если индикатора нет, просто добавляем в конец
        answersSection.appendChild(newAnswer);
    }
}

// Защита от XSS
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function (m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    }).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function (c) {
        return c;
    });
}
        // Отправка вопроса
//async function sendQuestion(questionText) {
//    // Если уже выполняется запрос — игнорируем
//    if (isRequestInProgress) return;

//    // Блокируем интерфейс
//    setUIState(true);

//    loadingIndicator.style.display = 'flex';
//    loadingIndicator.innerHTML = `
//        <span>Ассистент печатает</span>
//        <div class="loading-dots">
//            <span></span><span></span><span></span>
//        </div>
//    `;

//    if (answersSection.firstChild !== loadingIndicator) {
//        answersSection.insertBefore(loadingIndicator, answersSection.firstChild);
//    }

//    try {
//        const response = await fetch('/api/llama-question', {
//            method: 'POST',
//            headers: { 'Content-Type': 'application/json' },
//            body: JSON.stringify({ question: questionText })
//        });

//        if (!response.ok) throw new Error(`Ошибка: ${response.status}`);

//        const data = await response.json();
//        const answerText = data.text || 'Нет текста';
//        const fileName = data.fileName || 'Нет файла';
//        const url = data.url && data.url != 'unknown' ? data.url : 'https://adygnet.ru/';

//        loadingIndicator.style.display = 'none';

//        addAnswerToDOM(questionText, answerText, fileName, url);
//        saveAnswerToHistory(questionText, answerText, fileName, url);

//    } catch (error) {
//        console.error('Ошибка:', error);
//        loadingIndicator.style.display = 'none';
//        addAnswerToDOM('Ошибка', error.message, 'Повторите попытку позже', '#');
//    } finally {
//        // РАЗБЛОКИРУЕМ интерфейс в любом случае (успех/ошибка)
//        setUIState(false);
//    }
//}
async function sendQuestion(questionText) {
    if (isRequestInProgress) return;
    setUIState(true);

    // Создаём контейнер для ответа
    const newAnswer = document.createElement('div');
    newAnswer.className = 'answer-item';
    newAnswer.innerHTML = `
        <div class="answer-question">${escapeHtml(questionText)}</div>
        <div class="answer-text"></div>
        <div class="answer-sources"></div>
        <div class="loading-inline" style="display: flex; align-items: center; gap: 8px; color: #666; font-size: 13px; margin-top: 10px;">
            <span>Обработка запроса...</span>
            <div class="loading-dots">
                <span></span><span></span><span></span>
            </div>
        </div>
    `;

    // Вставляем в начало
    answersSection.insertBefore(newAnswer, answersSection.firstChild);

    const answerTextDiv = newAnswer.querySelector('.answer-text');
    const sourcesDiv = newAnswer.querySelector('.answer-sources');
    const inlineLoader = newAnswer.querySelector('.loading-inline');

    let hasStartedPrinting = false;

    try {
        const response = await fetch('/api/llama-question-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: questionText })
        });

        if (!response.ok) throw new Error(`Ошибка: ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullAnswer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            fullAnswer += chunk;

            // Когда появился первый текст — меняем индикатор
            if (!hasStartedPrinting && fullAnswer.length > 0 && !fullAnswer.includes('[SOURCE]')) {
                hasStartedPrinting = true;
                inlineLoader.innerHTML = `
                    <span>Ассистент печатает...</span>
                    <div class="loading-dots">
                        <span></span><span></span><span></span>
                    </div>
                `;
            }

            // Очищаем от метаданных источника
            let displayText = fullAnswer;
            const sourceMatch = fullAnswer.match(/\[SOURCE\]:[^|]+\|[^\n]+/);
            if (sourceMatch) {
                displayText = fullAnswer.replace(/\[SOURCE\]:[^|]+\|[^\n]+/, '');
            }

            // Показываем текст (печатается сверху)
            if (displayText.trim().length > 0) {
                answerTextDiv.innerHTML = marked.parse(displayText);
            }
        }

        // Убираем индикатор
        inlineLoader.style.display = 'none';

        // Парсим источник
        const sourceMatch = fullAnswer.match(/\[SOURCE\]:([^|]+)\|([^\n]+)/);
        if (sourceMatch) {
            const fileName = sourceMatch[1];
            const fileUrl = sourceMatch[2];
            const cleanAnswer = fullAnswer.replace(/\[SOURCE\]:[^|]+\|[^\n]+/, '');
            answerTextDiv.innerHTML = marked.parse(cleanAnswer);
            sourcesDiv.innerHTML = `<a class="source-tag" href="${escapeHtml(fileUrl)}" target="_blank">${escapeHtml(fileName)}</a>`;
        } else {
            sourcesDiv.innerHTML = `<span class="source-tag">Источник: Qdrant</span>`;
        }

        // Сохраняем в историю
        saveAnswerToHistory(questionText, answerTextDiv.innerHTML, sourceMatch ? sourceMatch[1] : 'Qdrant', sourceMatch ? sourceMatch[2] : 'https://adygnet.ru/');

    } catch (error) {
        console.error('Ошибка:', error);
        inlineLoader.style.display = 'none';
        answerTextDiv.innerHTML = '❌ Ошибка: ' + error.message;
    } finally {
        setUIState(false);
    }
}
// Блокировка интерфейса на время запроса
function setUIState(disabled) {
    isRequestInProgress = disabled;

    // Блокируем/разблокируем кнопку "Спросить"
    sendButton.disabled = disabled;
    sendButton.style.opacity = disabled ? '0.6' : '1';
    sendButton.style.cursor = disabled ? 'not-allowed' : 'pointer';

    // Блокируем/разблокируем поле ввода
    questionInput.disabled = disabled;
    questionInput.style.backgroundColor = disabled ? '#f5f5f5' : 'white';

    // Блокируем/разблокируем примеры вопросов
    examples.forEach(example => {
        example.style.pointerEvents = disabled ? 'none' : 'auto';
        example.style.opacity = disabled ? '0.5' : '1';
        example.style.cursor = disabled ? 'not-allowed' : 'pointer';
    });
}

// ========== СТРИМИНГ (ответ по буквам) ==========
async function sendQuestionStream(questionText) {
    // Блокируем интерфейс
    if (isRequestInProgress) return;
    setUIState(true);

    loadingIndicator.style.display = 'flex';
    loadingIndicator.innerHTML = `
        <span>Ассистент печатает</span>
        <div class="loading-dots">
            <span></span><span></span><span></span>
        </div>
    `;

    if (answersSection.firstChild !== loadingIndicator) {
        answersSection.insertBefore(loadingIndicator, answersSection.firstChild);
    }

    // Создаём контейнер для ответа
    const newAnswer = document.createElement('div');
    newAnswer.className = 'answer-item';
    newAnswer.innerHTML = `
        <div class="answer-question">${escapeHtml(questionText)}</div>
        <div class="answer-text"></div>
        <div class="answer-sources"></div>
    `;
    answersSection.insertBefore(newAnswer, loadingIndicator);

    const answerTextDiv = newAnswer.querySelector('.answer-text');
    const sourcesDiv = newAnswer.querySelector('.answer-sources');

    try {
        const response = await fetch('/api/llama-question-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: questionText })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullAnswer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            fullAnswer += chunk;
            answerTextDiv.textContent = fullAnswer;

            // Автоскролл
            answerTextDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }

        // Добавляем заглушку для источника (потом можно доработать)
        sourcesDiv.innerHTML = `<span class="source-tag">📄 Источник: Qdrant</span>`;

        loadingIndicator.style.display = 'none';

        // Сохраняем в историю
        saveAnswerToHistory(questionText, fullAnswer, 'Источник: Qdrant', 'https://adygnet.ru/');

    } catch (error) {
        console.error('[STREAM ERROR]', error);
        answerTextDiv.textContent = '❌ Ошибка: ' + error.message;
        loadingIndicator.style.display = 'none';
    } finally {
        setUIState(false);
    }
}
        // Клик по кнопке
sendButton.addEventListener('click', () => {
    if (isRequestInProgress) return; 
    const question = questionInput.value.trim();
    if (question) {
        sendQuestion(question);
        questionInput.value = '';
    }
});
        
        // Отправка по Enter
questionInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !isRequestInProgress) {  
        const question = questionInput.value.trim();
        if (question) {
            sendQuestion(question);
            questionInput.value = '';
        }
    }
});
        // Клик по примерам
examples.forEach(example => {
    example.addEventListener('click', () => {
        const questionText = example.textContent;
        questionInput.value = questionText;
        sendQuestion(questionText);
        questionInput.value = ''; // Очистить (или можно не очищать, если хочешь)
    });
});

const clearChatBtn = document.getElementById('clearChatBtn');
if (clearChatBtn) {
    clearChatBtn.addEventListener('click', () => {
        if (confirm('Очистить всю историю вопросов? Это действие нельзя отменить.')) {
            clearChatHistory();
        }
    });
}

const adminBtn = document.getElementById('adminBtn');
const adminModal = document.getElementById('adminModal');
const closeModal = document.getElementById('closeModal');
const adminLoginBtn = document.getElementById('adminLoginBtn');

if (adminBtn) {
    adminBtn.onclick = () => {
        if (adminModal) adminModal.style.display = 'flex';
    };
}

if (closeModal) {
    closeModal.onclick = () => {
        if (adminModal) adminModal.style.display = 'none';
    };
}

if (adminLoginBtn) {
    adminLoginBtn.onclick = () => {
        const login = document.getElementById('adminLogin')?.value;
        const password = document.getElementById('adminPassword')?.value;

        if (login === 'Admin' && password === 'Admin') {
            sessionStorage.setItem('adminAuth', 'true');
            window.location.href = 'admin.html';
        } else {
            alert('Неверный логин или пароль');
        }
    };
}
// ========== ЛОГИКА ВИДЖЕТА ==========
const widgetToggle = document.getElementById('widgetToggle');
const widgetContainer = document.getElementById('widgetContainer');
const widgetClose = document.getElementById('widgetClose');

let isWidgetOpen = false;
let isAnimating = false;

function openWidget() {
    if (isAnimating || isWidgetOpen) return;
    isAnimating = true;
    isWidgetOpen = true;
    widgetContainer.classList.remove('closing');
    widgetContainer.classList.add('open');
    setTimeout(() => { isAnimating = false; }, 300);
}

function closeWidget() {
    if (isAnimating || !isWidgetOpen) return;
    isAnimating = true;
    widgetContainer.classList.add('closing');
    setTimeout(() => {
        widgetContainer.classList.remove('open', 'closing');
        isWidgetOpen = false;
        isAnimating = false;
    }, 300);
}

if (widgetToggle) {
    widgetToggle.addEventListener('click', () => {
        if (isWidgetOpen) {
            closeWidget();
        } else {
            openWidget();
        }
    });
}

if (widgetClose) {
    widgetClose.addEventListener('click', () => {
        closeWidget();
    });
}

// Закрытие по клику вне виджета
document.addEventListener('click', (e) => {
    if (isWidgetOpen && isAnimating === false) {
        if (!widgetContainer.contains(e.target) && !widgetToggle.contains(e.target)) {
            closeWidget();
        }
    }
});
document.addEventListener('DOMContentLoaded', function () {
    loadChatHistory();
});