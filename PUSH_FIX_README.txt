PUSH FIX (важно)
Если у тебя на сайте ошибка вида:
  Uncaught SyntaxError: expected expression, got '<<'
то в репозитории оказался файл с git-конфликтными маркерами (<<<<<<< ======= >>>>>>>).

Как залить ЭТУ чистую версию так, чтобы точно перезаписать сломанный app.js:

1) Подтянуть remote и убедиться что никто не пушит параллельно:
   git fetch origin

2) (Опционально) Быстро проверить конфликтные маркеры:
   powershell -ExecutionPolicy Bypass -File tools\check_conflicts.ps1

3) Перезаписать файлы из архива поверх проекта (распаковка).

4) Закоммитить и запушить:
   git add -A
   git commit -m "Fix: remove conflict markers in app.js"
   git push --force-with-lease origin main

--force-with-lease безопаснее чем --force: он не перезапишет ветку, если с момента fetch кто-то успел запушить.
