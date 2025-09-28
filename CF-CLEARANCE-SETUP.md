# CF-Clearance-Scraper Integration

Система автоматического получения cf_clearance токенов теперь использует CF-Clearance-Scraper как основной метод.

## Установка CF-Clearance-Scraper

1. **Скачайте CF-Clearance-Scraper:**
   ```bash
   git clone https://github.com/your-repo/cf-clearance-scraper.git
   ```

2. **Установите зависимости:**
   ```bash
   cd cf-clearance-scraper
   pip install -r requirements.txt
   ```

3. **Убедитесь что установлен Google Chrome**

4. **Поместите папку cf-clearance-scraper в корень проекта bplacer:**
   ```
   bplacer/
   ├── cf-clearance-scraper/
   │   ├── main.py
   │   ├── requirements.txt
   │   └── ...
   ├── server.js
   └── ...
   ```

## Как это работает

### Двухуровневая система:

1. **🥇 CF-Clearance-Scraper (основной):**
   - Современный Python-скрипт с поддержкой всех типов Cloudflare challenges
   - Работает с JavaScript, managed и interactive challenge
   - Более стабильный и надежный

2. **🥈 CloudFreed Extension (fallback):**
   - Запускается автоматически если Python-скрипт недоступен
   - Браузерное расширение как резервный метод

### Автоматическое обновление:

- ✅ Проверка валидности токена каждые 10 минут
- ✅ Автоматическое получение при истечении токена
- ✅ Автоматическое получение при ошибках 403/503
- ✅ Веб-интерфейс для управления автоматическим режимом

## Команды CF-Clearance-Scraper

Система использует следующую команду:

```bash
python main.py -f temp_cf_cookies.json -ua "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" -t 60 --headed https://bplace.org/
```

Параметры:
- `-f` - файл для сохранения cookies в JSON формате
- `-ua` - user agent для совместимости с requests
- `-t` - timeout в секундах (60)
- `--headed` - запуск браузера в видимом режиме
- URL - https://bplace.org/

## Управление через веб-интерфейс

Перейдите на http://localhost:3001/manual-cookies для управления:

- **🤖 Автоматически получить cf_clearance** - запуск получения токена
- **▶️/⏹️ Включить/Отключить автоматический режим** - управление периодической проверкой
- **🔄 Принудительно обновить cf_clearance** - форсированное обновление токена

## API Endpoints

- `POST /auto-get-token` - получить cf_clearance токен
- `POST /toggle-auto-mode` - включить/отключить автоматический режим
- `POST /force-token-refresh` - принудительно обновить токен
- `GET /auto-token-status` - получить статус автоматического режима

## Логи

Система логирует все операции с префиксами:
- `📝 [CF-Scraper]:` - вывод Python-скрипта
- `⚠️ [CF-Scraper Error]:` - ошибки Python-скрипта
- `🤖` - операции автоматического режима
- `🕐 [PERIODIC]` - периодические проверки

## Требования

- Python 3.7+
- Google Chrome
- Зависимости из requirements.txt CF-Clearance-Scraper
- Директория cf-clearance-scraper в корне проекта

## Troubleshooting

1. **Python script not found:**
   - Убедитесь что папка `cf-clearance-scraper` находится в корне проекта
   - Проверьте что файл `main.py` существует

2. **Python command failed:**
   - Установите Python и добавьте в PATH
   - Установите зависимости: `pip install -r requirements.txt`

3. **Chrome not found:**
   - Установите Google Chrome
   - Убедитесь что Chrome доступен в системе

4. **Token not generated:**
   - Проверьте логи сервера
   - Попробуйте запустить CF-Clearance-Scraper вручную
   - Используйте CloudFreed как fallback