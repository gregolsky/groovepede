if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/groovepede/sw.js', { scope: '/groovepede/' })
    .then(() => console.log("Service Worker Registered"));
}