const express = require('express');
const cors    = require('cors');
const { spawn, exec } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const marked  = require('marked');

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// ========== ПУТИ ==========
// const CSHARP_PARSER_PATH  = 'C:/Users/Everrain_17/Desktop/Kursovik/Project/server/HTMLParser.exe';
// const CSHARP_SCANNER_PATH = 'C:/Users/Everrain_17/Desktop/Kursovik/Project/server/ExtractorSystem.exe';
const CSHARP_PARSER_PATH = 'HTMLParser.exe';
const CSHARP_SCANNER_PATH = 'ExtractorSystem.exe';
const SETTINGS_PATH       = path.join(__dirname, 'settings.json');

// llama.cpp server (instead of Ollama)
const LLAMA_BASE_URL = 'http://127.0.0.1:8080';

// Микросервис контекста (get_context_server.py)
// const CONTEXT_SERVICE_URL = 'http://localhost:5001';
const QDRANT_SERVICE_URL = 'http://localhost:5001';

// Папки данных
// let DATA_FOLDER = 'C:/Users/Everrain_17/Desktop/Kursovik/Project/server/DataBase';
let DATA_FOLDER = path.join(__dirname, 'DataBase');
let PDF_FOLDER  = path.join(DATA_FOLDER, 'PDF_Documents');

// Активные процессы
let currentParseProcess  = null;
let currentScanProcess   = null;
let currentPythonProcess = null;

// SSE клиенты
let scanClients = [];
let batchUploadClients = [];

let isBatchUploadActive = false;
let batchUploadAbortController = null;

// ========== НАСТРОЙКИ ==========
function loadSettings() {
    if (fs.existsSync(SETTINGS_PATH)) {
        try {
            const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
            if (settings.savePath) {
                DATA_FOLDER = settings.savePath;
                PDF_FOLDER  = path.join(DATA_FOLDER, 'PDF_Documents');
            }
            return settings;
        } catch (e) {
            console.error('[SETTINGS] Ошибка чтения settings.json:', e.message);
        }
    }
    return { savePath: DATA_FOLDER, maxDocs: 100 };
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

loadSettings();

// ========== SSE ==========
function sendScanProgress(data) {
    scanClients.forEach(client => {
        try { client.res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) { }
    });
}

// ========== КОНТЕКСТ ЧЕРЕЗ МИКРОСЕРВИС ==========
// Вместо spawn нового Python-процесса на каждый запрос — HTTP к постоянному сервису.
// Это решает:
//   - одновременные запросы с разных устройств (нет гонки за Qdrant-соединение)
//   - долгую загрузку модели (грузится один раз при старте get_context_server.py)
//   - RuntimeWarning про закрытие соединения (клиент живёт постоянно)
async function getContextFromService(query) {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 15000);

    try {
        // const response = await fetch(`${CONTEXT_SERVICE_URL}/context`, {
        const response = await fetch(`${QDRANT_SERVICE_URL}/context`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                query: query,
                collection_name: 'university'
            }),
            signal:  controller.signal
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Микросервис контекста вернул ${response.status}: ${text}`);
        }

        const data = await response.json();
        if (data.error) console.warn('[CONTEXT] Предупреждение:', data.error);
        console.log(`[CONTEXT] Найдено фрагментов: ${data.count ?? 0}`);
        
        // Возвращаем оба поля: строку контекста и список документов
        return {
            context: data.context || '',
            documents: data.documents || []
        };

    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error('Таймаут микросервиса контекста (15 сек)');
        }
        throw new Error(
            `Ошибка микросервиса контекста: ${err.message}. ` +
            `Убедись, что запущен: python get_context_server.py`
        );
    } finally {
        clearTimeout(timer);
    }
}

// Helper function to send progress
function sendBatchProgress(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // Also send to SSE clients
    sendBatchProgressToSSE(data);
}

function sendBatchProgressToSSE(data) {
    batchUploadClients.forEach(client => {
        try {
            client.res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
            console.error('SSE send error:', e);
        }
    });
}


// ========== API ==========

app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
    const { savePath, maxDocs } = req.body;
    const settings = loadSettings();
    if (savePath !== undefined) settings.savePath = savePath;
    if (maxDocs  !== undefined) settings.maxDocs  = maxDocs;
    saveSettings(settings);
    DATA_FOLDER = settings.savePath;
    PDF_FOLDER  = path.join(DATA_FOLDER, 'PDF_Documents');
    console.log('updated data folder and pdf folder: ', DATA_FOLDER, PDF_FOLDER);
    res.json({ success: true, settings });
});

app.get('/api/stats', (req, res) => {
    try {
        let totalSize = 0, totalFiles = 0;
        if (fs.existsSync(PDF_FOLDER)) {
            for (const file of fs.readdirSync(PDF_FOLDER)) {
                const fp = path.join(PDF_FOLDER, file);
                if (fs.statSync(fp).isFile() && file.toLowerCase().endsWith('.pdf')) {
                    totalSize += fs.statSync(fp).size;
                    totalFiles++;
                }
            }
        }
        res.json({ success: true, totalFiles, totalSizeMB: (totalSize / 1024 / 1024).toFixed(2) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/documents/real-count', (req, res) => {
    try {
        console.log(DATA_FOLDER, PDF_FOLDER);
        let pdfCount = 0, files = [];
        if (fs.existsSync(PDF_FOLDER)) {
            for (const file of fs.readdirSync(PDF_FOLDER)) {
                const fp   = path.join(PDF_FOLDER, file);
                const stat = fs.statSync(fp);
                if (stat.isFile() && file.toLowerCase().endsWith('.pdf')) {
                    pdfCount++;
                    files.push({ name: file, size: stat.size, modified: stat.mtime });
                }
            }
        }
        res.json({ success: true, count: pdfCount, files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/scan-results', (req, res) => {
    const settings = loadSettings();
    const jsonPath  = path.join(settings.savePath || DATA_FOLDER, 'ScanResults', 'vector_knowledge_base.json');
    if (fs.existsSync(jsonPath)) {
        res.json(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
    } else {
        res.json([]);
    }
});

app.post('/api/parse', (req, res) => {
    const { url } = req.body;

    const settings = loadSettings();

    if (!settings.savePath?.trim())
        return res.status(400).json({ success: false, error: 'Путь сохранения не указан' });
    if (!fs.existsSync(CSHARP_PARSER_PATH))
        return res.status(500).json({ success: false, error: 'C# парсер не найден' });
    if (currentParseProcess !== null)
        return res.status(409).json({ success: false, error: 'Парсинг уже запущен' });

    if (!fs.existsSync(PDF_FOLDER)) fs.mkdirSync(PDF_FOLDER, { recursive: true });

    currentParseProcess = spawn(CSHARP_PARSER_PATH, [url, DATA_FOLDER ]);
    currentParseProcess.stdout.on('data', (data) => {
        console.log('[PARSER]', data.toString('utf8').trim());
    });
    currentParseProcess.stderr.on('data', (data) => {
        console.error('[PARSER ERR]', data.toString('utf8').trim());
    });

    currentParseProcess.on('close', (code) => {
        currentParseProcess = null;
        let count = 0;
        if (fs.existsSync(PDF_FOLDER))
            count = fs.readdirSync(PDF_FOLDER).filter(f => f.toLowerCase().endsWith('.pdf')).length;
        res.json({ success: code === 0, documentsCount: count });
    });

});

app.post('/api/stop-parse', (req, res) => {
    if (currentParseProcess) {
        exec(`taskkill /pid ${currentParseProcess.pid} /f /t`, () => { });
        currentParseProcess.kill('SIGKILL');
        currentParseProcess = null;
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.get('/api/parse-status', (req, res) => {
    res.json({ isRunning: currentParseProcess !== null });
});

app.post('/api/start-scan', (req, res) => {
    const settings = loadSettings();

    if (!settings.savePath?.trim())
        return res.status(400).json({ success: false, error: 'Путь сохранения не указан' });
    if (!fs.existsSync(CSHARP_SCANNER_PATH))
        return res.status(500).json({ success: false, error: 'C# сканер не найден' });

    const regPath      = path.join(settings.savePath, 'documents_registry.json');
    const pdfDir       = path.join(settings.savePath, 'PDF_Documents');
    const outDir       = path.join(settings.savePath, 'ScanResults');
    const jsonPath     = path.join(outDir, 'vector_knowledge_base.json');
    const pythonScript = path.join(__dirname, '..', 'embedding.py');

    if (!fs.existsSync(regPath))
        return res.status(400).json({ success: false, error: 'Реестр документов не найден' });
    if (currentScanProcess !== null)
        return res.status(409).json({ success: false, error: 'Сканирование уже запущено' });

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    console.log('Запуск C# сканера...');
    currentScanProcess = spawn(CSHARP_SCANNER_PATH, [regPath, pdfDir, outDir]);

    currentScanProcess.stdout.on('data', (data) => {
        const text = data.toString('utf8');
        console.log('[SCANNER]', text);
        for (const line of text.split('\n')) {
            if (line.trim().startsWith('{')) {
                try { sendScanProgress(JSON.parse(line)); } catch (e) { }
            } else if (line.trim().length > 0) {
                sendScanProgress({ type: 'log', message: line });
            }
        }
    });

    currentScanProcess.stderr.on('data', (data) => {
        console.error('[SCANNER ERR]', data.toString('utf8'));
    });

    currentScanProcess.on('close', (code) => {
        console.log(`C# сканер завершён с кодом ${code}`);
        currentScanProcess = null;

        if (code !== 0) {
            sendScanProgress({ type: 'finished', success: false, error: 'C# сканер завершился с ошибкой' });
            return;
        }

        sendScanProgress({ type: 'log', message: 'C# сканер завершён, запуск Python...' });

        if (!fs.existsSync(pythonScript)) {
            sendScanProgress({ type: 'finished', success: false, error: 'Python скрипт embedding.py не найден' });
            return;
        }

        currentPythonProcess = spawn('python', [pythonScript, jsonPath]);

        currentPythonProcess.stdout.on('data', (data) => {
            const text = data.toString('utf8');
            console.log('[PYTHON]', text);
            sendScanProgress({ type: 'log', message: `[PYTHON] ${text}` });
        });

        currentPythonProcess.stderr.on('data', (data) => {
            const text = data.toString('utf8');
            console.error('[PYTHON ERR]', text);
            sendScanProgress({ type: 'log', message: `[PYTHON ERR] ${text}`, isError: true });
        });

        currentPythonProcess.on('close', (pythonCode) => {
            console.log(`Python завершён с кодом ${pythonCode}`);
            currentPythonProcess = null;
            sendScanProgress({
                type:    'finished',
                success: pythonCode === 0,
                message: pythonCode === 0 ? 'Полное сканирование завершено' : 'Ошибка в Python'
            });
        });
    });

    res.json({ success: true, message: 'Сканирование запущено' });
});

app.post('/api/stop-scan', (req, res) => {
    console.log('[STOP] Stop requested by user');
    // The actual stop logic is in the frontend
    // But we can still send an SSE event if needed
    sendScanProgress({ type: 'stop_requested', message: 'Остановка сканирования...' });
    res.json({ success: true, message: 'Остановка запрошена' });
});

app.get('/api/scan-status', (req, res) => {
    res.json({ isRunning: currentScanProcess !== null || currentPythonProcess !== null });
});

app.get('/api/scan-progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const clientId = Date.now();
    scanClients.push({ id: clientId, res });
    req.on('close', () => {
        const i = scanClients.findIndex(c => c.id === clientId);
        if (i !== -1) scanClients.splice(i, 1);
    });
});

// SSE endpoint for batch upload progress
app.get('/api/batch-upload-progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');  // Disable nginx buffering
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const clientId = Date.now();
    batchUploadClients.push({ id: clientId, res });
    
    req.on('close', () => {
        batchUploadClients = batchUploadClients.filter(c => c.id !== clientId);
    });
});

app.delete('/api/documents/clear', (req, res) => {
    try {
        const registryPath = path.join(DATA_FOLDER, 'documents_registry.json');
        if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
        if (fs.existsSync(PDF_FOLDER)) {
            for (const file of fs.readdirSync(PDF_FOLDER)) {
                const fp = path.join(PDF_FOLDER, file);
                if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
            }
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/batch-upload', async (req, res) => {
    console.log('batch upload started');
    console.log('PDF_FOLDER path:', PDF_FOLDER);
    console.log('Folder exists?', fs.existsSync(PDF_FOLDER));
    
    if (isBatchUploadActive) {
        return res.status(409).json({ success: false, error: 'Batch upload already in progress' });
    }

    isBatchUploadActive = true;
    batchUploadAbortController = new AbortController();

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
        const files = fs.readdirSync(PDF_FOLDER).filter(file => file.toLowerCase().endsWith('.pdf'));

        sendBatchProgress(res, { type: 'start', total: files.length, message: `Найдено ${files.length} PDF файлов` });
        console.log(`Найдено ${files.length} PDF файлов`);

        let totalUploaded = 0;
        let totalChunks = 0;
        
        for (let i = 0; i < files.length; i++) {
            if (batchUploadAbortController.signal.aborted) {
                sendBatchProgress(res, { type: 'stopped', message: 'Загрузка остановлена пользователем' });
                break;
            }

            const fileName = files[i];
            const filePath = path.join(PDF_FOLDER, fileName);
            console.log(fileName, filePath);

            sendBatchProgress(res, { 
                type: 'progress', 
                current: i + 1, 
                total: files.length,
                file: fileName,
                percent: Math.round(((i + 1) / files.length) * 100)
            });

            try {
                const response = await fetch(`${QDRANT_SERVICE_URL}/upload`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_path: filePath,
                        file_name: fileName,
                        doc_type: 'pdf',
                        program: 'all',
                        url: ''
                    }),
                    signal: batchUploadAbortController.signal
                });

                const result = await response.json();
                
                if (result.success) {
                    totalUploaded += result.uploaded || 1;
                    totalChunks += result.chunks || 0;
                    sendBatchProgress(res, { 
                        type: 'file_complete', 
                        file: fileName, 
                        chunks: result.chunks,
                        success: true
                    });
                } else {
                    sendBatchProgress(res, { 
                        type: 'file_complete', 
                        file: fileName, 
                        error: result.error,
                        success: false
                    });
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    break;
                }
                sendBatchProgress(res, { 
                    type: 'file_complete', 
                    file: fileName, 
                    error: err.message,
                    success: false
                });
            }
        }

        sendBatchProgress(res, { 
            type: 'finished', 
            totalUploaded, 
            totalChunks,
            success: true,
            message: `Загрузка завершена. Загружено: ${totalUploaded} файлов, ${totalChunks} чанков`
        });
    } catch (error) {
        console.log('batch upload error');
        sendBatchProgress(res, { type: 'error', message: error.message });
    } finally {
        console.log('bath upload finally');
        isBatchUploadActive = false;
        batchUploadAbortController = null;
        res.end();
    }
});


app.post('/api/stop-batch-upload', (req, res) => {
    if (batchUploadAbortController && isBatchUploadActive) {
        batchUploadAbortController.abort();
        sendBatchProgressToSSE({ type: 'stopped', message: 'Остановка запрошена...' });
        res.json({ success: true, message: 'Остановка batch upload запрошена' });
    } else {
        res.json({ success: false, message: 'Нет активной загрузки' });
    }
});


// Add upload endpoint (proxy to the unified service)
app.post('/api/upload-document', async (req, res) => {
    try {
        console.log(req.body);
        const response = await fetch(`${QDRANT_SERVICE_URL}/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/collection-count/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const response = await fetch(`${QDRANT_SERVICE_URL}/collections/${name}/count`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/collection-docs-count/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const response = await fetch(`${QDRANT_SERVICE_URL}/collections/${name}/count-docs`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/search', async (req, res) => {
    try {
        const response = await fetch(`${QDRANT_SERVICE_URL}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ========== ВОПРОС К LLAMA.CPP С КОНТЕКСТОМ ==========
app.post('/api/llama-question', async (req, res) => {
    console.log('[DEBUG] Запрос получен:', req.body.question?.slice(0, 50));
    try {
        const questionText = req.body.question;
        if (!questionText?.trim()) {
            return res.status(400).json({ success: false, message: 'Вопрос не предоставлен' });
        }

        try {
            // 1. Получаем контекст из микросервиса (строку и список документов)
            console.log('[LLAMA] Вопрос:', questionText);
            let contextData = { context: '', documents: [] };
            try {
                contextData = await getContextFromService(questionText);
                console.log(`[LLAMA] Контекст: ${contextData.context.length} символов, документов: ${contextData.documents.length}`);
            } catch (contextError) {
                console.error('[LLAMA] Ошибка контекста:', contextError.message);
                // Продолжаем без контекста
            }

            const request_body = JSON.stringify({
                model: "qwen3.5",
                messages: [
                    {
                        "role": "system",
                        "content": `
                        Отвечай на вопросы, используя только предоставленный контекст. Если ответа нет в контексте, скажи, что не знаешь. Если несколько документов отвечают на вопрос, используй документ с самой новой датой. Не добавляй информацию из своих знаний. Отвечай кратко и по существу. Выводи ответ используя следущую JSON схему:
                        
                        [Формат вывода]
                        {
                            "answer": "ответ на вопрос в формате markdown",
                            "id": "номера документов, использованных для ответа. если номеров несколько, перечисли их через запятую"
                        }

                        СТИЛЬ ОТВЕТА (ОБЯЗАТЕЛЬНО):
                        - Отвечай ТОЛЬКО в формате markdown
                        - Используй маркированные списки (* пункт) для перечисления
                        - Используй нумерованные списки (1., 2., 3.)
                        - НЕ повторяй одну и ту же информацию в разных формулировках
                        - КАЖДЫЙ уникальный пункт ТОЛЬКО ОДИН раз
                        - Если информация повторяется в разных разделах контекста, объедини её

                        Если вопрос задан в очень общей форме (например, одно-два слова без уточнения), постарайся дать ОПРЕДЕЛЕНИЕ понятия, основные причины/условия/порядок действий в соответствии с контекстом. Не сужай ответ до одного частного случая.
                        Если вопрос про то, КАК получить что-либо, обязательно перечисли ВСЕ критерии, а не только один.
                        Если вопрос задан по стоимости обучания, отвечай, что это нужно уточнять в деканате.

                        Если попадаются документы с МГГТК (Майкопский государственный гуманитарно-технический колледж), игнорируй их.
                        Если попадаются документы с mggtk или мггтк в названии файла, игнорируй их.

                        Отвечай на русском.
                        `
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": `
                            Вопрос: ${questionText}

                            Контекст:
                            ${contextData.context || 'Контекст не предоставлен'}`
                            }
                        ]
                    }
                ],
                temperature: 0.3,
                top_k: 20,
                top_p: 0.95,
                min_p: 0.0,
                repeat_last_n: 512,
                repeat_penalty: 1.1,
                presence_penalty: 0.0,
                dry_multiplier: 0.8,
                dry_base: 1.5,
                dry_allowed_length: 3,
                dry_penalty_last_n: 512,
                n_predict: 1024,

                response_format: {
                    "type": "json_object"
                }
            });

            console.log(request_body);

            // 3. Запрос к llama.cpp server (compatible with OpenAI-like API)
            const llamaResponse = await fetch(`${LLAMA_BASE_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: request_body
            });

            if (!llamaResponse.ok) {
                const errText = await llamaResponse.text();
                throw new Error(`llama.cpp API error ${llamaResponse.status}: ${errText}`);
            }

            const data = await llamaResponse.json();

            // Extract the generated text from response
            let cleanAnswer = '';
            if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
                cleanAnswer = data.choices[0].message.content;
            } else if (data.content) {
                cleanAnswer = data.content;
            } else {
                cleanAnswer = data.response || '';
            }

            // Remove any think blocks if present
            cleanAnswer = cleanAnswer.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            cleanAnswer = cleanAnswer.replace(/```/gi, '').trim();
            cleanAnswer = cleanAnswer.replace(/json/gi, '').trim();

            let answer = cleanAnswer;
            let docId = -1;
            let docUrl = null;
            let docFileName = null;

            try {
                // Parse the string as JSON if it contains valid JSON
                let parsedData;
                if (typeof cleanAnswer === 'string') {
                    parsedData = JSON.parse(cleanAnswer);
                } else {
                    parsedData = cleanAnswer;
                }
                answer = parsedData.answer || '';
                answer = marked.parse(answer);
                // Извлекаем ID документа
                const idMatch = String(parsedData.id).match(/\d+/);
                docId = idMatch ? parseInt(idMatch[0], 10) : -1;

                console.log("answer: ", answer, "docId: ", docId);

                // Находим документ по ID в списке documents из контекста
                if (docId !== -1 && contextData.documents && contextData.documents.length > 0) {
                    const foundDoc = contextData.documents.find(doc => doc.id === docId);
                    if (foundDoc) {
                        docUrl = foundDoc.url;
                        docFileName = foundDoc.fileName;
                        console.log(`Найден документ: ID=${docId}, URL=${docUrl}, File=${docFileName}`);
                    } else {
                        console.log(`Документ с ID ${docId} не найден в списке. Доступные ID: ${contextData.documents.map(d => d.id).join(', ')}`);
                    }
                }

            } catch (error) {
                console.error('[LLAMA] Failed to parse JSON from response:', error.message);
                console.log('[LLAMA] Raw response:', cleanAnswer.slice(0, 500));
            }

            console.log('[LLAMA] Ответ:', answer.slice(0, 200));

            res.json({
                success: true,
                text: answer,
                id: docId,
                url: docUrl,
                fileName: docFileName,
                contextUsed: contextData.context.length > 0,
                documentsCount: contextData.documents.length
            });

        } catch (error) {
            console.error('[LLAMA] Критическая ошибка:', error.message);
            res.status(500).json({ success: false, message: error.message });
        }
    } catch (error) {
        console.error('[DEBUG] КРИТИЧЕСКАЯ ОШИБКА:', error.stack);
        res.status(500).json({ success: false, message: error.message });
    }

    
});
// ========== СТРИМИНГ (ответ по буквам) ==========
// ========== СТРИМИНГ (ответ по буквам) ==========
app.post('/api/llama-question-stream', async (req, res) => {
    const questionText = req.body.question;

    console.log('[STREAM] Вопрос:', questionText);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    try {
        // Получаем контекст (как в обычном методе)
        let contextData = { context: '', documents: [] };
        try {
            contextData = await getContextFromService(questionText);
            console.log(`[STREAM] Контекст: ${contextData.context.length} символов, документов: ${contextData.documents.length}`);
        } catch (contextError) {
            console.error('[STREAM] Ошибка контекста:', contextError.message);
        }

        // ТОТ ЖЕ САМЫЙ ПРОМПТ, ЧТО В ОБЫЧНОМ МЕТОДЕ
        const systemPrompt = `
Отвечай на вопросы, используя только предоставленный контекст. Если ответа нет в контексте, скажи, что не знаешь. Если несколько документов отвечают на вопрос, используй документ с самой новой датой. Не добавляй информацию из своих знаний. Отвечай кратко и по существу. Выводи ответ используя следущую JSON схему:

[Формат вывода]
{
    "answer": "ответ на вопрос в формате markdown",
    "id": "номера документов, использованных для ответа. если номеров несколько, перечисли их через запятую"
}

СТИЛЬ ОТВЕТА (ОБЯЗАТЕЛЬНО):
- Отвечай ТОЛЬКО в формате markdown
- Используй маркированные списки (* пункт) для перечисления
- Используй нумерованные списки (1., 2., 3.)
- НЕ повторяй одну и ту же информацию в разных формулировках
- КАЖДЫЙ уникальный пункт ТОЛЬКО ОДИН раз
- Если информация повторяется в разных разделах контекста, объедини её

Если вопрос задан в очень общей форме (например, одно-два слова без уточнения), постарайся дать ОПРЕДЕЛЕНИЕ понятия, основные причины/условия/порядок действий в соответствии с контекстом. Не сужай ответ до одного частного случая.
Если вопрос про то, КАК получить что-либо, обязательно перечисли ВСЕ критерии, а не только один.
Если вопрос задан по стоимости обучания, отвечай, что это нужно уточнять в деканате.

Если попадаются документы с МГГТК (Майкопский государственный гуманитарно-технический колледж), игнорируй их.
Если попадаются документы с mggtk или мггтк в названии файла, игнорируй их.

Отвечай на русском.
`;

        const userPrompt = `Вопрос: ${questionText}\n\nКонтекст:\n${contextData.context || 'Контекст не предоставлен'}`;

        // Запрос к llama.cpp со стримингом
        const response = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "qwen3.5",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                stream: true,
                temperature: 0.3,
                max_tokens: 1024,
                response_format: { "type": "json_object" }
            })
        });

        if (!response.ok) {
            throw new Error(`llama.cpp error: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';

        // Собираем весь ответ
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        const json = JSON.parse(data);
                        const token = json.choices[0]?.delta?.content || '';
                        if (token) {
                            fullContent += token;
                        }
                    } catch (e) { }
                }
            }
        }

        console.log('[STREAM] Полный ответ:', fullContent.slice(0, 200));

        // Парсим JSON как в обычном методе
        let cleanAnswer = fullContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        cleanAnswer = cleanAnswer.replace(/```json/gi, '').replace(/```/gi, '').trim();

        let answer = cleanAnswer;
        let docId = -1;
        let docUrl = null;
        let docFileName = null;

        try {
            const parsedData = JSON.parse(cleanAnswer);
            answer = parsedData.answer || cleanAnswer;
            answer = marked.parse(answer);

            const idMatch = String(parsedData.id).match(/\d+/);
            docId = idMatch ? parseInt(idMatch[0], 10) : -1;

            if (docId !== -1 && contextData.documents && contextData.documents.length > 0) {
                const foundDoc = contextData.documents.find(doc => doc.id === docId);
                if (foundDoc) {
                    docUrl = foundDoc.url;
                    docFileName = foundDoc.fileName;
                }
            }
        } catch (error) {
            console.error('[STREAM] JSON parse error:', error.message);
            answer = marked.parse(cleanAnswer);
        }

        // Отправляем ответ по БУКВАМ (как и было)
        // Отправляем ответ по буквам
        for (let i = 0; i < answer.length; i++) {
            res.write(answer[i]);
            await new Promise(r => setTimeout(r, 10));
        }

        // Отправляем источник в специальном формате, который поймёт фронтенд
        if (docFileName) {
            res.write(`\n\n[SOURCE]:${docFileName}|${docUrl || 'https://adygnet.ru/'}`);
        }

        res.end();
        console.log('[STREAM] Готово');

    } catch (error) {
        console.error('[STREAM ERROR]', error);
        res.write('Ошибка: ' + error.message);
        res.end();
    }
});

// ========== СТАРТ ==========
app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log(`llama.cpp сервер: ${LLAMA_BASE_URL}`);
    // console.log(`Микросервис контекста: ${CONTEXT_SERVICE_URL}`);
    console.log(`Микросервис qdrant: ${QDRANT_SERVICE_URL}`);
    console.log(`Данные: ${DATA_FOLDER}`);
    console.log(`\n⚠️  Не забудь запустить отдельно:`);
    console.log(`   1. python get_context_server.py`);
    console.log(`   2. llama-server -m your_model.gguf --host 127.0.0.1 --port 8080`);
});
