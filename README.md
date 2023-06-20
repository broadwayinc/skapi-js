# skapi

Complete JAM Stack, front-end driven backend API service designed to simplify the web development.

## For HTML projects

```html
<!DOCTYPE html>
<script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
<body>
  ...
</body>
<script>
  const skapi = new Skapi('your_service_id', 'your_user_id');
  // ... Start Coding!
</script>
```

## For webpack projects

To use skapi in a webpack-based project (such as Vue, React, or Angular), install skapi-js from npm:

```sh
$ npm install skapi-js@latest
```

Then, import the library into your main JavaScript file:

```javascript
// main.js
import { Skapi } from 'skapi-js';
const skapi = new Skapi('your_service_id', 'your_user_id');

// Import the exported class from any file you may want to use skapi
export { skapi };
```

For more info, visit our [documentation page](https://docs.skapi.com)