"""
qdrant_service.py — унифицированный микросервис для работы с Qdrant.
Поддерживает:
- Получение контекста (поиск)
- Загрузку документов (чанкинг + эмбеддинги)
- Управление коллекциями

Запускать: python qdrant_service.py
Слушает на http://localhost:5001
"""

import sys
import io
import os
import threading
import tempfile
import re
from pathlib import Path
from typing import List, Dict, Any, Optional

# UTF-8 фикс
if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'buffer'):
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

try:
    from flask import Flask, request, jsonify
    from sentence_transformers import SentenceTransformer
    from qdrant_client import QdrantClient, models
    import pymupdf4llm
    from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
    from transformers import AutoTokenizer
    import requests
    from bs4 import BeautifulSoup
except ImportError as e:
    print(f"[IMPORT ERROR] {e}", file=sys.stderr, flush=True)
    print("Установи зависимости: pip install flask sentence-transformers qdrant-client pymupdf4llm langchain-text-splitters transformers requests beautifulsoup4", file=sys.stderr, flush=True)
    sys.exit(1)

# ========== НАСТРОЙКИ ==========
QDRANT_URL = os.environ.get('QDRANT_URL', 'http://localhost:6333')
COLLECTION_NAME = os.environ.get('QDRANT_COLLECTION', 'university')
MODEL_NAME = os.environ.get('EMBED_MODEL', 'deepvk/USER-bge-m3')
LIMIT = int(os.environ.get('QDRANT_LIMIT', '10'))
PORT = int(os.environ.get('SERVICE_PORT', '5001'))

# Настройки чанкинга
CHUNK_SIZE = int(os.environ.get('CHUNK_SIZE', '256'))
CHUNK_OVERLAP = int(os.environ.get('CHUNK_OVERLAP', '20'))

# ========== ЗАГРУЗКА МОДЕЛИ И ТОКЕНИЗАТОРА (ОДИН РАЗ) ==========
print(f"[INIT] Загрузка токенизатора '{MODEL_NAME}'...", flush=True)
try:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    print("[INIT] Токенизатор загружен.", flush=True)
except Exception as e:
    print(f"[INIT ERROR] Не удалось загрузить токенизатор: {e}", file=sys.stderr, flush=True)
    sys.exit(1)

print(f"[INIT] Загрузка модели '{MODEL_NAME}'...", flush=True)
try:
    model = SentenceTransformer(MODEL_NAME, device='cpu')
    print("[INIT] Модель загружена.", flush=True)
except Exception as e:
    print(f"[INIT ERROR] Не удалось загрузить модель: {e}", file=sys.stderr, flush=True)
    sys.exit(1)

# ========== ПОДКЛЮЧЕНИЕ К QDRANT ==========
print(f"[INIT] Подключение к Qdrant: {QDRANT_URL}...", flush=True)
try:
    qdrant_client = QdrantClient(url=QDRANT_URL, timeout=10.0)
    collections = [c.name for c in qdrant_client.get_collections().collections]
    
    if COLLECTION_NAME not in collections:
        print(f"[INIT] Создание коллекции '{COLLECTION_NAME}'...", flush=True)
        qdrant_client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=models.VectorParams(
                size=1024,  # Размерность USER-bge-m3
                distance=models.Distance.COSINE
            )
        )
        print(f"[INIT] Коллекция '{COLLECTION_NAME}' создана.", flush=True)
    else:
        print(f"[INIT] Коллекция '{COLLECTION_NAME}' найдена.", flush=True)
except Exception as e:
    print(f"[INIT ERROR] Не удалось подключиться к Qdrant: {e}", file=sys.stderr, flush=True)
    sys.exit(1)

# ========== НАСТРОЙКИ СПЛИТТЕРОВ ==========
headers_to_split_on = [
    ("#", "Header 1"),
    ("##", "Header 2"),
    ("###", "Header 3")
]
markdown_text_splitter = MarkdownHeaderTextSplitter(
    headers_to_split_on=headers_to_split_on,
    strip_headers=False
)

separators = ['\n\n', '\n', ' ']
recursive_text_splitter = RecursiveCharacterTextSplitter.from_huggingface_tokenizer(
    tokenizer=tokenizer,
    separators=separators,
    chunk_size=CHUNK_SIZE,
    chunk_overlap=CHUNK_OVERLAP
)

# Мьютекс для потокобезопасного кодирования
# encode_lock = threading.Lock()

# ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

def chunk_text(doc: str) -> List[Dict[str, Any]]:
    """Split document into chunks using hierarchical splitting."""
    try:
        pages = markdown_text_splitter.split_text(doc)
        chunks = []
        
        for page in pages:
            recursive_chunks = recursive_text_splitter.split_text(page.page_content)
            chunks.extend([
                {
                    'metadata': page.metadata,
                    'text': chunk.strip()
                }
                for chunk in recursive_chunks if chunk.strip()
            ])
        
        print(f"Created {len(chunks)} chunks from document", flush=True)
        return chunks
    except Exception as e:
        print(f"Error chunking text: {e}", flush=True)
        raise

def upload_documents_to_qdrant(documents: list) -> dict:
    """Загружает документы в Qdrant."""
    all_chunks = []
    all_payloads = []
    
    for idx, doc in enumerate(documents):
        try:
            text = doc.get('text', '')
            if not text:
                print(f"[WARN] Документ {idx} не содержит текста", flush=True)
                continue
                
            chunks = chunk_text(text)
            print(f"[INFO] Документ '{doc.get('file_name', 'unknown')}' → {len(chunks)} чанков", flush=True)
            
            for chunk_idx, chunk in enumerate(chunks):
                all_chunks.append(chunk['text'])
                all_payloads.append({
                    'text': chunk['text'],
                    'metadata': {
                        'headers': chunk['metadata'],
                        'file_name': doc.get('file_name', ''),
                        'url': doc.get('url', ''),
                        'doc_type': doc.get('doc_type', 'unknown'),
                        'program': doc.get('program', 'all'),
                        'chunk_index': chunk_idx,
                        'source_index': idx
                    }
                })
        except Exception as e:
            print(f"[ERROR] Ошибка обработки документа {idx}: {e}", flush=True)
            continue
    
    if not all_chunks:
        return {'uploaded': 0, 'chunks': 0, 'error': 'Нет текста для загрузки'}
    
    # Генерируем эмбеддинги
    print(f"[INFO] Генерация эмбеддингов для {len(all_chunks)} чанков...", flush=True)
   # with encode_lock:
    embeddings = model.encode(all_chunks, normalize_embeddings=True)
    
    # Получаем текущий максимальный ID
    try:
        count_result = qdrant_client.count(collection_name=COLLECTION_NAME)
        start_id = count_result.count
    except:
        start_id = 0

    try:
        qdrant_client.upload_collection(
            collection_name=COLLECTION_NAME,
            vectors=embeddings,
            payload=all_payloads
        )
        print(f"[INFO] Загружено {len(all_chunks)} чанков", flush=True)
        return {'uploaded': len(documents), 'chunks': len(all_chunks), 'error': None}
    except Exception as e:
        print(f"[ERROR] Ошибка загрузки: {e}", flush=True)
        return {'uploaded': 0, 'chunks': 0, 'error': str(e)}

# ========== FLASK ПРИЛОЖЕНИЕ ==========
app = Flask(__name__)

# ---------- HEALTH ----------
@app.route('/health', methods=['GET'])
def health():
    """Проверка работоспособности."""
    return jsonify({
        'status': 'ok',
        'model': MODEL_NAME,
        'collection': COLLECTION_NAME,
        'chunk_size': CHUNK_SIZE,
        'limit': LIMIT
    })

# ---------- RETRIEVAL ENDPOINTS (как в get_context_server.py) ----------
@app.route('/context', methods=['POST'])
def get_context():
    """Получение контекста для LLM."""
    data = request.get_json(silent=True)
    if not data or not data.get('query', '').strip():
        return jsonify({'context': '', 'documents': [], 'count': 0, 'error': 'Пустой запрос'}), 400

    query = data['query'].strip()
    collection_name = data['collection_name'] if data['collection_name'] else COLLECTION_NAME

    try:
        #with encode_lock:
        embedding = model.encode(query, normalize_embeddings=True)

        result = qdrant_client.query_points(
            collection_name=collection_name,
            query=embedding,
            with_payload=True,
            limit=LIMIT
        )

        if not result or not result.points:
            print(f"[INFO] Qdrant: 0 результатов для '{query}'", flush=True)
            return jsonify({'context': '', 'documents': [], 'count': 0, 'error': None})

        documents = []
        context_parts = []

        for i, point in enumerate(result.points):
            payload = point.payload or {}
            text = payload.get('text', '').strip()
            metadata = payload.get('metadata', {})
            url = metadata.get('url', '').strip()
            file_name = metadata.get('file_name', '').strip()

            if text:
                documents.append({
                    'id': i,
                    'text': text,
                    'url': url if url else None,
                    'fileName': file_name if file_name else None,
                    'score': point.score if hasattr(point, 'score') else None
                })

                context_parts.append(f"""Документ {i}: {text}. URL: {url}. Название файла: {file_name}""")

        context = '\n---\n'.join(context_parts)
        print(f"[INFO] Запрос: '{query[:50]}' → найдено {len(documents)} фрагментов", flush=True)

        return jsonify({
            'context': context,
            'documents': documents,
            'count': len(documents),
            'error': None
        })

    except Exception as e:
        print(f"[ERROR] Ошибка при обработке запроса: {e}", file=sys.stderr, flush=True)
        return jsonify({'context': '', 'documents': [], 'count': 0, 'error': str(e)}), 500

# ---------- UPLOAD ENDPOINTS ----------
@app.route('/upload', methods=['POST'])
def upload_document():
    """Загрузка документа (JSON или файл)."""
    data = request.get_json(silent=True)
    if not data or not data.get('file_path'):
        return jsonify({'success': False, 'error': 'file_path required'}), 400
    
    file_path = data['file_path']
    file_name = data.get('file_name', os.path.basename(file_path))
    url = data.get('url', '')
    doc_type = data.get('doc_type', 'pdf')
    program = data.get('program', 'all')
    
    print(f"Processing file: {file_path}", flush=True)
    
    if not os.path.exists(file_path):
        return jsonify({'success': False, 'error': f'File not found: {file_path}'}), 404
    
    try:
        text = pymupdf4llm.to_markdown(file_path, ocr_language='rus')
        result = upload_documents_to_qdrant([{
            'text': text,
            'file_name': file_name,
            'url': url,
            'doc_type': doc_type,
            'program': program
        }])
        return jsonify({'success': result['error'] is None, **result})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        pass

    return jsonify({'success': result['error'] is None, **result})

@app.route('/upload-from-urls', methods=['POST'])
def upload_from_urls():
    """Загрузка документов по URL."""
    data = request.get_json(silent=True)
    if not data or not data.get('documents'):
        return jsonify({'success': False, 'error': 'Список документов не предоставлен'}), 400
    
    documents = []
    for doc in data['documents']:
        url = doc.get('url')
        if not url:
            continue
        
        try:
            response = requests.get(url, timeout=30, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, 'html.parser')
            for script in soup(["script", "style"]):
                script.decompose()
            text = soup.get_text()
            text = re.sub(r'\n\s*\n', '\n\n', text)
            text = text.strip()
            
            documents.append({
                'text': text,
                'file_name': doc.get('file_name', url.split('/')[-1] or 'webpage'),
                'url': url,
                'doc_type': 'web-page',
                'program': doc.get('program', 'all')
            })
            print(f"[INFO] Загружено: {url}", flush=True)
        except Exception as e:
            print(f"[ERROR] Ошибка {url}: {e}", flush=True)
            continue
    
    if not documents:
        return jsonify({'success': False, 'error': 'Не удалось загрузить ни одного документа'}), 400
    
    result = upload_documents_to_qdrant(documents)
    return jsonify({'success': result['error'] is None, **result})

# ---------- COLLECTION MANAGEMENT ----------
@app.route('/collections', methods=['GET'])
def get_collections():
    """Список коллекций."""
    try:
        collections = qdrant_client.get_collections()
        return jsonify({'success': True, 'collections': [c.name for c in collections.collections]})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/collections/<name>/count', methods=['GET'])
def get_collection_count(name):
    """Количество точек в коллекции."""
    try:
        result = qdrant_client.count(collection_name=name)
        return jsonify({'success': True, 'collection': name, 'count': result.count})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/collections/<name>/count-docs', methods=['GET'])
def get_collection_docs_count(name):
    """Количество точек в коллекции."""
    try:
        result = qdrant_client.count(collection_name=name)
        return jsonify({'success': True, 'collection': name, 'count': result.count})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/collections/<name>/clear', methods=['DELETE'])
def clear_collection(name):
    """Очистка коллекции (удаление всех точек)."""
    try:
        # Получаем информацию о коллекции
        collection_info = qdrant_client.get_collection(collection_name=name)
        vector_size = collection_info.config.params.vectors.size
        
        # Удаляем и пересоздаём коллекцию
        qdrant_client.delete_collection(collection_name=name)
        qdrant_client.create_collection(
            collection_name=name,
            vectors_config=models.VectorParams(size=vector_size, distance=models.Distance.COSINE)
        )
        return jsonify({'success': True, 'message': f'Коллекция {name} очищена'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ---------- SEARCH ONLY ----------
@app.route('/search', methods=['POST'])
def search_only():
    """Только поиск (без форматирования)."""
    data = request.get_json(silent=True)
    if not data or not data.get('query', '').strip():
        return jsonify({'documents': [], 'count': 0, 'error': 'Пустой запрос'}), 400

    query = data['query'].strip()
    program_filter = data.get('program')

    try:
        #with encode_lock:
        embedding = model.encode(query, normalize_embeddings=True)

        filter_condition = None
        if program_filter and program_filter != 'all':
            filter_condition = models.Filter(
                must=[
                    models.FieldCondition(
                        key='metadata.program',
                        match=models.MatchValue(value=program_filter)
                    )
                ]
            )

        result = qdrant_client.query_points(
            collection_name=COLLECTION_NAME,
            query=embedding,
            query_filter=filter_condition,
            with_payload=True,
            limit=LIMIT
        )

        documents = []
        for point in result.points or []:
            payload = point.payload or {}
            metadata = payload.get('metadata', {})
            documents.append({
                'id': point.id,
                'text': payload.get('text', '').strip(),
                'url': metadata.get('url', ''),
                'fileName': metadata.get('file_name', ''),
                'headers': metadata.get('headers', {}),
                'score': point.score if hasattr(point, 'score') else None
            })

        return jsonify({'documents': documents, 'count': len(documents), 'error': None})
    except Exception as e:
        return jsonify({'documents': [], 'count': 0, 'error': str(e)}), 500


if __name__ == '__main__':
    print("=" * 60)
    print(f"QDRANT УНИФИЦИРОВАННЫЙ СЕРВИС")
    print("=" * 60)
    print(f"Сервер: http://localhost:{PORT}")
    print(f"Qdrant: {QDRANT_URL}")
    print(f"Коллекция: {COLLECTION_NAME}")
    print(f"Модель: {MODEL_NAME}")
    print(f"Размер чанка: {CHUNK_SIZE}, перекрытие: {CHUNK_OVERLAP}")
    print("=" * 60)
    print("ENDPOINTS:")
    print("  GET  /health                    - проверка")
    print("  POST /context                   - получить контекст для LLM")
    print("  POST /search                    - только поиск")
    print("  POST /upload                    - загрузить документ")
    print("  POST /upload-from-urls          - загрузить по URL")
    print("  GET  /collections               - список коллекций")
    print("  GET  /collections/<name>/count  - количество точек")
    print("  DELETE /collections/<name>/clear - очистка коллекции")
    print("=" * 60)
    app.run(host='0.0.0.0', port=PORT, threaded=True)