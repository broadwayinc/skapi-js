# skapi

Serverless-based backend API service designed to simplify your application's security and database management.


## For HTML projects

To import skapi into an HTML project, add the following script to the head tag of your HTML file:

```html
<!DOCTYPE html>
<html>
<head>
    <script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
    ...
</head>
<body>
    ...
</body>
<script>
  const skapi = new Skapi('your_service_id', 'your_user_id');
</script>
</html>
```

## For webpack projects

To use skapi in a webpack-based project (such as Vue, React, or Angular), first install skapi-js from npm:

```sh
$ npm install skapi-js@latest
```

Then, import the library into your main JavaScript file:

```javascript
// main.js
import { Skapi } from 'skapi-js';
const skapi = new Skapi('your_service_id', 'your_user_id');
```