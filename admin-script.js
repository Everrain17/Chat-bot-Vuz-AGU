if (!sessionStorage.getItem('adminAuth')) {
    window.location.href = 'index.html';
}

const API_URL = '';

let parseEventSource = null;
let scanEventSource = null;
let batchUploadEventSource = null;
let stopScanRequested = false;

// Элементы
const parseUrl = document.getElementById('parseUrl');
const startParseBtn = document.getElementById('startParseBtn');
const stopParseBtn = document.getElementById('stopParseBtn');
const parseResult = document.getElementById('parseResult');
const parseProgressCard = document.getElementById('parseProgressCard');
const parseProgressBar = document.getElementById('parseProgressBar');
const parseProgressStatus = document.getElementById('parseProgressStatus');
const parseLog = document.getElementById('parseLog');
const documentsList = document.getElementById('documentsList');
const refreshStorageBtn = document.getElementById('refreshStorageBtn');
const clearStorageBtn = document.getElementById('clearStorageBtn');
const searchDocs = document.getElementById('searchDocs');
const logoutBtn = document.getElementById('logoutBtn');
const serverStatusSpan = document.getElementById('serverStatus');
const totalDocsSpan = document.getElementById('totalDocs');
const totalSizeSpan = document.getElementById('totalSize');
const savePathInput = document.getElementById('savePath');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const startScanProcessBtn = document.getElementById('startScanProcessBtn');
const stopScanProcessBtn = document.getElementById('stopScanProcessBtn');
const scanProgressCard = document.getElementById('scanProgressCard');
const scanProgressBar = document.getElementById('scanProgressBar');
const scanStatus = document.getElementById('scanStatus');
const scanLog = document.getElementById('scanLog');
const scannedDocsCount = document.getElementById('scannedDocsCount');
const scannedChunksCount = document.getElementById('scannedChunksCount');
const lastScanTime = document.getElementById('lastScanTime');
const refreshScanResultsBtn = document.getElementById('refreshScanResultsBtn');

// Новые элементы для управления коллекцией
const collectionNameInput = document.getElementById('collectionName');
const clearCollectionBtn = document.getElementById('clearCollectionBtn');
const collectionStatsSpan = document.getElementById('collectionStats');

// Тексты
const TXT_ENTER_URL = "Введите URL для парсинга";
const TXT_PARSING_START = "Парсинг запущен...";
const TXT_PARSING_SUCCESS = "Парсинг завершен";
const TXT_TOTAL_DOCS = "Всего документов";
const TXT_LOAD_ERROR = "Ошибка загрузки данных";
const TXT_AVAILABLE = "Доступен";
const TXT_UNAVAILABLE = "Недоступен";
const TXT_NO_DATA = "Нет данных. Запустите парсинг.";
const TXT_DELETE_CONFIRM = "Вы уверены, что хотите удалить все данные?";
const TXT_CLEAR_ERROR = "Ошибка при очистке";
const TXT_CLEAR_COLLECTION_CONFIRM = "Вы уверены, что хотите очистить коллекцию? Все векторы будут удалены!";

// ========== ТАБЫ ==========
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
        document.getElementById(`${tabId}Tab`).classList.add('active');
        if (tabId === 'storage') { loadDocuments(); loadStats(); }
        if (tabId === 'scan') { loadScanResults(); loadCollectionStats(); }
        if (tabId === 'settings') { loadSettings(); loadStats(); }
    });
});

// ========== ПАРСИНГ (загрузка документов в Qdrant) ==========
function addParseLog(message, isError = false) {
    const timestamp = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.style.color = isError ? '#dc3545' : '#666';
    div.style.fontSize = '12px';
    div.style.margin = '2px 0';
    div.textContent = `[${timestamp}] ${message}`;
    parseLog.appendChild(div);
    parseLog.scrollTop = parseLog.scrollHeight;
}

function connectParseProgress() {
    if (parseEventSource) parseEventSource.close();
    // parseEventSource = new EventSource(`${API_URL}/api/parse-progress`);
    parseEventSource = new EventSource(`${API_URL}/api/parse-status`);
    parseEventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'output') {
            addParseLog(data.data);
        } else if (data.type === 'finished') {
            parseProgressBar.style.width = '100%';
            parseProgressBar.textContent = '100%';
            parseProgressStatus.textContent = data.success ? 'Загрузка документов завершена!' : 'Загрузка завершилась с ошибкой';
            startParseBtn.disabled = false;
            stopParseBtn.style.display = 'none';
            setTimeout(() => { parseProgressCard.style.display = 'none'; }, 2000);
            loadDocuments();
            loadStats();
            loadCollectionStats(); // Обновляем статистику коллекции
        } else if (data.type === 'stopped') {
            parseProgressStatus.textContent = 'Загрузка остановлена';
            startParseBtn.disabled = false;
            stopParseBtn.style.display = 'none';
            addParseLog('Загрузка документов остановлена пользователем');
        }
    };
}

if (startParseBtn) {
    startParseBtn.addEventListener('click', async () => {
        const url = parseUrl.value.trim();
        if (!url) {
            parseResult.innerHTML = `<div class="parse-result error">${TXT_ENTER_URL}</div>`;
            return;
        }

        startParseBtn.disabled = true;
        stopParseBtn.style.display = 'inline-block';
        parseProgressCard.style.display = 'block';
        parseLog.innerHTML = '';
        parseProgressBar.style.width = '0%';
        parseProgressBar.textContent = '0%';
        parseProgressStatus.textContent = 'Парсинг запущен...';
        parseResult.innerHTML = `<div class="loading">${TXT_PARSING_START}</div>`;

        // Опрашиваем статус каждую секунду пока идёт парсинг
        const statusInterval = setInterval(async () => {
            try {
                const s = await fetch(`${API_URL}/api/parse-status`);
                const d = await s.json();
                if (d.isRunning) {
                    parseProgressStatus.textContent = 'Парсинг в процессе...';
                    addParseLog('Работаем...');
                }
            } catch {}
        }, 2000);

        try {
            const response = await fetch(`${API_URL}/api/parse`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });
            const data = await response.json();

            clearInterval(statusInterval); // останавливаем опрос

            if (!data.success) {
                parseResult.innerHTML = `<div class="parse-result error">Ошибка: ${data.error || data.message}</div>`;
                addParseLog(`Ошибка: ${data.error || data.message}`, true);
            } else {
                parseResult.innerHTML = `<div class="parse-result success"><strong>${TXT_PARSING_SUCCESS}</strong><br>${TXT_TOTAL_DOCS}: ${data.documentsCount || 0}</div>`;
                parseProgressBar.style.width = '100%';
                parseProgressBar.textContent = '100%';
                parseProgressStatus.textContent = 'Завершено!';
                addParseLog(`Готово! Скачано документов: ${data.documentsCount || 0}`);
                loadDocuments();
                loadStats();
            }
        } catch (error) {
            clearInterval(statusInterval);
            parseResult.innerHTML = `<div class="parse-result error">Ошибка подключения: ${error.message}</div>`;
            addParseLog(`Ошибка: ${error.message}`, true);
        } finally {
            // ВСЕГДА разблокируем кнопку
            startParseBtn.disabled = false;
            stopParseBtn.style.display = 'none';
        }
    });
}

if (stopParseBtn) {
    stopParseBtn.addEventListener('click', async () => {
        if (!confirm('Остановить загрузку?')) return;
        try {
            await fetch(`${API_URL}/api/stop-parse`, { method: 'POST' });
        } catch (error) {
            alert('Ошибка: ' + error.message);
        }
    });
}

// ========== ХРАНИЛИЩЕ ==========
async function loadDocuments() {
    try {
        const response = await fetch(`${API_URL}/api/documents/real-count`);
        const result = await response.json();
        if (result.success) {
            updateStats(result.count);
            renderDocumentsList(result.files);
        }
    } catch (error) {
        if (documentsList) documentsList.innerHTML = `<p class="text-muted">${TXT_LOAD_ERROR}</p>`;
        if (serverStatusSpan) serverStatusSpan.textContent = TXT_UNAVAILABLE;
    }
}

function updateStats(count) {
    const statsContainer = document.getElementById('storageStats');
    if (statsContainer) {
        statsContainer.innerHTML = `<div class="stat-item"><div class="stat-value">${count}</div><div class="stat-label">Всего PDF</div></div>
            <div class="stat-item"><div class="stat-value">${count}</div><div class="stat-label">В папке</div></div>
            <div class="stat-item"><div class="stat-value">-</div><div class="stat-label">Объем текста</div></div>`;
    }
    if (totalDocsSpan) totalDocsSpan.textContent = count;
    if (serverStatusSpan) serverStatusSpan.textContent = TXT_AVAILABLE;
}

function renderDocumentsList(files) {
    if (!documentsList) return;
    const searchTerm = searchDocs ? searchDocs.value.toLowerCase() : '';
    const filtered = files.filter(file => file.name.toLowerCase().includes(searchTerm));
    if (filtered.length === 0) {
        documentsList.innerHTML = `<p class="text-muted">${TXT_NO_DATA}</p>`;
        return;
    }
    documentsList.innerHTML = filtered.map(file => `
        <div class="doc-item">
            <div class="doc-info">
                <div class="doc-name"><strong>${file.name}</strong></div>
                <div class="doc-meta">Размер: ${(file.size / 1024).toFixed(1)} KB<br>Изменён: ${new Date(file.modified).toLocaleString()}</div>
            </div>
            <div class="doc-actions">
                <button onclick="viewDocument('${file.name}')" title="Просмотр">👁️</button>
            </div>
        </div>
    `).join('');
}

window.viewDocument = (fileName) => { alert(`Документ: ${fileName}`); };

if (refreshStorageBtn) refreshStorageBtn.addEventListener('click', () => {
    loadDocuments();
    loadStats();
});
if (clearStorageBtn) {
    clearStorageBtn.addEventListener('click', async () => {
        if (confirm(TXT_DELETE_CONFIRM)) {
            try {
                await fetch(`${API_URL}/api/documents/clear`, { method: 'DELETE' });
                loadDocuments(); loadStats();
            } catch (error) { alert(TXT_CLEAR_ERROR); }
        }
    });
}
if (searchDocs) searchDocs.addEventListener('input', () => { loadDocuments(); });

// ========== СКАНИРОВАНИЕ (работа с Qdrant) ==========

function addScanLog(message, isError = false) {
    const timestamp = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.style.color = isError ? '#dc3545' : '#666';
    div.style.fontSize = '12px';
    div.style.margin = '2px 0';
    div.textContent = `[${timestamp}] ${message}`;
    scanLog.appendChild(div);
    scanLog.scrollTop = scanLog.scrollHeight;
}

function connectScanProgress() {
    if (scanEventSource) scanEventSource.close();
    scanEventSource = new EventSource(`${API_URL}/api/scan-progress`);
    scanEventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'progress') {
            const percent = (data.current / data.total) * 100;
            scanProgressBar.style.width = percent + '%';
            scanProgressBar.textContent = Math.floor(percent) + '%';
            scanStatus.textContent = `Обработка: ${data.file} (${data.current} из ${data.total})`;
            addScanLog(`Обработан: ${data.file} (${data.current}/${data.total})`);
        } else if (data.type === 'complete') {
            addScanLog(`Загружен в Qdrant: ${data.file} (${data.chunks || 0} чанков)`);
            if (data.chunks) {
                loadCollectionStats(); // Обновляем статистику после каждой загрузки
            }
        } else if (data.type === 'error') {
            addScanLog(`Ошибка: ${data.file} - ${data.error}`, true);
        } else if (data.type === 'log') {
            addScanLog(data.message);
        } else if (data.type === 'finished') {
            scanStatus.textContent = data.success ? 'Загрузка в Qdrant завершена успешно!' : 'Загрузка завершилась с ошибкой';
            scanProgressBar.style.width = '100%';
            scanProgressBar.textContent = '100%';
            addScanLog(data.success ? '=== ЗАГРУЗКА В QDRANT ЗАВЕРШЕНА ===' : '=== ОШИБКА ПРИ ЗАГРУЗКЕ ===', !data.success);
            startScanProcessBtn.disabled = false;
            stopScanProcessBtn.style.display = 'none';
            loadCollectionStats(); // Финальное обновление статистики
        } else if (data.type === 'stopped') {
            scanStatus.textContent = 'Загрузка остановлена';
            addScanLog('Загрузка остановлена пользователем');
            startScanProcessBtn.disabled = false;
            stopScanProcessBtn.style.display = 'none';
        }
    };
}


if (startScanProcessBtn) {
    startScanProcessBtn.addEventListener('click', async () => {
        startScanProcessBtn.disabled = true;
        stopScanProcessBtn.style.display = 'inline-block';
        scanProgressCard.style.display = 'block';
        scanLog.innerHTML = '';
        scanProgressBar.style.width = '0%';
        scanProgressBar.textContent = '0%';
        scanStatus.textContent = 'Подготовка к загрузке...';
        addScanLog('=== НАЧАЛО ЗАГРУЗКИ PDF В QDRANT ===');
        addScanLog(`Коллекция: ${collectionNameInput ? collectionNameInput.value : 'university'}`);
        
        // Connect to SSE for progress updates
        if (batchUploadEventSource) {
            batchUploadEventSource.close();
        }
        
        batchUploadEventSource = new EventSource(`${API_URL}/api/batch-upload-progress`);
        batchUploadEventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            switch(data.type) {
                case 'start':
                    addScanLog(data.message);
                    break;
                    
                case 'progress':
                    scanProgressBar.style.width = data.percent + '%';
                    scanProgressBar.textContent = data.percent + '%';
                    scanStatus.textContent = `Загрузка: ${data.file} (${data.current}/${data.total})`;
                    addScanLog(`[${data.current}/${data.total}] Загрузка: ${data.file}`);
                    break;
                    
                case 'file_complete':
                    if (data.success) {
                        addScanLog(`✓ ${data.file}: ${data.chunks} чанков`);
                    } else {
                        addScanLog(`✗ ${data.file}: ${data.error}`, true);
                    }
                    break;
                    
                case 'finished':
                    addScanLog(`=== ЗАГРУЗКА ЗАВЕРШЕНА ===`);
                    addScanLog(data.message);
                    scanStatus.textContent = data.message;
                    scanProgressBar.style.width = '100%';
                    scanProgressBar.textContent = '100%';
                    loadCollectionStats();
                    startScanProcessBtn.disabled = false;
                    stopScanProcessBtn.style.display = 'none';
                    batchUploadEventSource.close();
                    batchUploadEventSource = null;
                    break;
                    
                case 'stopped':
                    addScanLog('⚠️ Загрузка остановлена пользователем', true);
                    scanStatus.textContent = 'Загрузка остановлена';
                    startScanProcessBtn.disabled = false;
                    stopScanProcessBtn.style.display = 'none';
                    batchUploadEventSource.close();
                    batchUploadEventSource = null;
                    break;
                    
                case 'error':
                    addScanLog(`ОШИБКА: ${data.message}`, true);
                    startScanProcessBtn.disabled = false;
                    stopScanProcessBtn.style.display = 'none';
                    break;
            }
        };
        
        // Start the batch upload
        try {
            const response = await fetch(`${API_URL}/api/batch-upload`, {
                method: 'POST'
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Ошибка запуска загрузки');
            }
        } catch (error) {
            addScanLog(`КРИТИЧЕСКАЯ ОШИБКА: ${error.message}`, true);
            startScanProcessBtn.disabled = false;
            stopScanProcessBtn.style.display = 'none';
            if (batchUploadEventSource) {
                batchUploadEventSource.close();
                batchUploadEventSource = null;
            }
        }
    });
}


if (stopScanProcessBtn) {
    stopScanProcessBtn.addEventListener('click', async () => {
        if (!confirm('Остановить загрузку в Qdrant?')) return;
        addScanLog('Запрос остановки загрузки...');
        
        try {
            await fetch(`${API_URL}/api/stop-batch-upload`, { method: 'POST' });
        } catch (error) {
            console.error('Ошибка при остановке:', error);
        }
    });
}

if (clearCollectionBtn) {
    clearCollectionBtn.addEventListener('click', async () => {
        if (!confirm(TXT_CLEAR_COLLECTION_CONFIRM)) return;
        const collectionName = collectionNameInput ? collectionNameInput.value : 'university';
        
        try {
            addScanLog(`Очистка коллекции '${collectionName}'...`);
            const result = await clearQdrantCollection(collectionName);
            
            if (result.success) {
                addScanLog(`Коллекция '${collectionName}' успешно очищена`);
                loadCollectionStats();
                alert(`Коллекция '${collectionName}' очищена`);
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            addScanLog(`Ошибка очистки: ${error.message}`, true);
            alert(`Ошибка очистки: ${error.message}`);
        }
    });
}

async function loadCollectionStats() {
    try {
        const collectionName = collectionNameInput ? collectionNameInput.value : 'university';
        const response = await fetch(`${API_URL}/api/collection-count/${collectionName}`);
        const data = await response.json();
        
        if (data.success) {
            if (collectionStatsSpan) {
                collectionStatsSpan.innerHTML = `
                    <div class="stat-item">
                        <div class="stat-value">${data.count || 0}</div>
                        <div class="stat-label">Всего чанков</div>
                    </div>
                `;
            }
            addScanLog(`Статистика коллекции '${collectionName}': ${data.count || 0} чанков`);
        } else {
            addScanLog(`Ошибка получения статистики: ${data.error}`, true);
        }
    } catch (error) {
        console.error('Ошибка загрузки статистики коллекции:', error);
        console.log(response);
        addScanLog(`Ошибка подключения к сервису: ${error.message}`, true);
    }
}

async function loadScanResults() {
    try {
        const collectionName = collectionNameInput ? collectionNameInput.value : 'university';
        const response = await fetch(`${API_URL}/api/collection-count/${collectionName}`);
        const data = await response.json();

        if (data.success) {
            scannedChunksCount.textContent = data.count;
        }
        
        if (scannedDocsCount) {
            // Получаем общее количество уникальных документов из Qdrant
            const uniqueDocs = new Set();
            if (data.documents) {
                data.documents.forEach(doc => {
                    if (doc.fileName) uniqueDocs.add(doc.fileName);
                });
            }
            scannedDocsCount.textContent = uniqueDocs.size;
        }
        
        if (lastScanTime) lastScanTime.textContent = new Date().toLocaleString();
    } catch (error) {
        console.error('Ошибка загрузки результатов:', error);
        addScanLog(`Ошибка загрузки статистики: ${error.message}`, true);
    }
}

if (refreshScanResultsBtn) {
    refreshScanResultsBtn.addEventListener('click', () => {
        loadScanResults();
        loadCollectionStats();
    });
}

// ========== НАСТРОЙКИ ==========
async function loadSettings() {
    try {
        const response = await fetch(`${API_URL}/api/settings`);
        const settings = await response.json();
        if (savePathInput) savePathInput.value = settings.savePath || '';
        if (collectionNameInput) collectionNameInput.value = settings.collectionName || 'university';
    } catch (error) {
        console.error('Ошибка загрузки настроек:', error);
        if (collectionNameInput) collectionNameInput.value = 'university';
    }
}

async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/api/stats`);
        const stats = await response.json();
        if (stats.success) {
            if (totalSizeSpan) totalSizeSpan.textContent = stats.totalSizeMB + ' MB';
            if (totalDocsSpan) totalDocsSpan.textContent = stats.totalFiles;
        }
    } catch (error) {
        console.error('Ошибка загрузки статистики:', error);
    }
}

if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', async () => {
        const savePath = savePathInput ? savePathInput.value.trim() : '';
        const collectionName = collectionNameInput ? collectionNameInput.value.trim() : 'university';
        
        if (!savePath) {
            alert('Укажите путь к папке!');
            return;
        }

        console.log('save path: ', savePath);
        
        try {
            const response = await fetch(`${API_URL}/api/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    savePath, 
                    maxDocs: 100,
                    collectionName: collectionName
                })
            });
            const result = await response.json();
            if (result.success) {
                alert('Настройки сохранены!');
                loadCollectionStats();
            } else {
                alert('Ошибка сохранения');
            }
        } catch (error) {
            alert('Ошибка подключения: ' + error.message);
        }
    });
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        sessionStorage.removeItem('adminAuth');
        window.location.href = 'index.html';
    });
}

// Старт
loadSettings();
loadStats();
loadDocuments();
loadCollectionStats();