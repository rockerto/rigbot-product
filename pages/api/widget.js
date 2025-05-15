export default function handler(req, res) {
  const { clientid } = req.query;
  
  // Puedes personalizar el widget según clientid en futuro
  const widgetCode = `
    (function(){
      var chatBubble = document.createElement('div');
      chatBubble.id = 'rigbot-bubble';
      chatBubble.style.position = 'fixed';
      chatBubble.style.bottom = '20px';
      chatBubble.style.right = '20px';
      chatBubble.style.width = '60px';
      chatBubble.style.height = '60px';
      chatBubble.style.backgroundColor = '#3b82f6';
      chatBubble.style.borderRadius = '50%';
      chatBubble.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
      chatBubble.style.cursor = 'pointer';
      chatBubble.innerHTML = '<span style="font-size:30px;color:white;position:absolute;top:10px;left:18px;">💬</span>';
      document.body.appendChild(chatBubble);

      chatBubble.onclick = function() {
        var iframe = document.createElement('iframe');
        iframe.src = 'https://tu-vercel-app-url/chat?clientid=${clientid}';
        iframe.style.position = 'fixed';
        iframe.style.bottom = '80px';
        iframe.style.right = '20px';
        iframe.style.width = '400px';
        iframe.style.height = '600px';
        iframe.style.border = '1px solid #ccc';
        iframe.style.zIndex = '99999';
        iframe.style.backgroundColor = 'white';
        document.body.appendChild(iframe);
      }
    })();
  `;

  res.setHeader('Content-Type', 'application/javascript');
  res.send(widgetCode);
}
