import json
import sys
import time

def main():
    # Имитация работы сканирования
    time.sleep(2)  # Пауза 2 секунды, как будто идет обработка
    
    # Возвращаем JSON результат
    result = {
        "success": True,
        "message": "Сканирование завершено",
        "details": {
            "files_processed": 2,
            "new_documents": 1,
            "scan_duration_seconds": 2
        }
    }
    
    # Выводим JSON в stdout (его поймает Node.js)
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
