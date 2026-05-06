const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'feed.html');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Remove mock stories
content = content.replace(/<div class="story"><div class="story-avatar"><div class="story-avatar-inner">.*?<\/div><\/div><div class="story-name">.*?<\/div><\/div>/g, '');

// 2. Remove mock posts
// Find the end of .create-post
const createPostEnd = content.indexOf('<div class="post">');
const rightSidebarStart = content.indexOf('<div class="right-sidebar">');

if (createPostEnd !== -1 && rightSidebarStart !== -1) {
    // The feed-container ends right before right-sidebar. We need to leave the closing </div> for .feed-content
    // Actually, let's just use regex to remove all <div class="post">...</div> that don't have id
    // Since real posts are appended dynamically, we can just remove all <div class="post"> that are currently in the HTML!
    // But wait, there might be nested divs. Let's just slice it.
    
    // Find the end of <div class="create-post"> ... </div>
    // It's easier to just do:
    let beforePosts = content.slice(0, createPostEnd);
    // Find the closing </div> of feed-content which is right before <div class="right-sidebar">
    let afterPosts = content.slice(content.lastIndexOf('</div>\n\n            <div class="right-sidebar">'));
    if (afterPosts.length > 0) {
        content = beforePosts + '            ' + afterPosts;
    }
}

// 3. Remove mock suggestions
content = content.replace(/<div class="suggestion-item">[\s\S]*?<\/button>\s*<\/div>/g, '');

// 4. Remove trending topics
content = content.replace(/<div class="trending-item">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g, '');

fs.writeFileSync(filePath, content, 'utf8');
console.log("Mock data removed from feed.html");
