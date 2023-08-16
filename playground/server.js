const http = require('http');
const fs = require('fs');

const get = (request, response) => {
    if (request.method === 'GET') {
        let url = request.url.split('?')[0];
        let filePath = '.' + url;
        if (filePath === './') {
            filePath = './index.html';
        }

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
                response.writeHead(200);
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