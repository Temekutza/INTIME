FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/index.html /usr/share/nginx/html/index.html
COPY web/styles.css web/app.js web/dashboard.js /usr/share/nginx/html/static/
COPY web/lib/ /usr/share/nginx/html/static/lib/

EXPOSE 80
