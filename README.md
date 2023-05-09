# skapi

Serverless-based backend API service designed to simplify the web development.

## For HTML projects

```html
<!DOCTYPE html>
<script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
<script>
  const skapi = new Skapi('your_service_id', 'your_user_id');
</script>
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