const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

files.forEach(file => {
    let content = fs.readFileSync(path.join(dir, file), 'utf8');
    const before = content;
    // Remove mock-server.js script tags
    content = content.replace(/<script src="mock-server\.js"><\/script>\s*/g, '');
    content = content.replace(/<script src='mock-server\.js'><\/script>\s*/g, '');
    if (content !== before) {
        fs.writeFileSync(path.join(dir, file), content, 'utf8');
        console.log('Removed mock-server.js from: ' + file);
    }
});
console.log('Done!');
