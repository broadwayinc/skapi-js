const http = require('http');
const fs = require('fs');
const path = require('path');

const get = (request, response) => {
    if (request.method === 'GET') {
        let url = request.url.split('?')[0];
        let filePath = '.' + url;
        if (filePath === './') {
            filePath = './index.html';
        }
        
        // Get file extension
        const extname = String(path.extname(filePath)).toLowerCase();

        // Define MIME types for a few common file extensions
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            // Add other MIME types as needed
        };

        // Set a default MIME type (optional)
        const contentType = mimeTypes[extname] || 'application/octet-stream';

        fs.readFile(filePath, function (error, content) {
            if (error) {
                if (error.code == 'ENOENT') {
                    response.writeHead(404);
                    response.end('NOT FOUND');
                }
                else {
                    response.writeHead(500);
                    response.end('FILE READ ERROR');
                }
            }
            else {
                response.writeHead(200, { 'Content-Type': contentType });
                response.end(content, 'utf-8');
            }
        });
    }
    else {
        response.writeHead(404);
        response.end('NOT FOUND');
    }
};

http.createServer(function (request, response) {
    try {
        get(request, response);
    }
    catch (err) {
        console.log(err);
        response.writeHead(500);
        response.end('SOMETHING WENT WRONG');
    }
}).listen(3000);

console.log('Server running at 3000...');