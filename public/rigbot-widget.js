(() => {
  const backendUrl = window.NEXT_PUBLIC_RIGBOT_BACKEND_URL || 'https://rigbot-1-0.vercel.app/api/chat';

  const createBubbles = () => {
    if (document.getElementById('rigbot-bubble')) return;

    const chatBubble = document.createElement('div');
    chatBubble.id = 'rigbot-bubble';
    chatBubble.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 90px;
      width: 64px;
      height: 64px;
      background: #007bff;
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 9999;
    `;
    chatBubble.innerHTML = `<span style="color: white; font-size: 32px;">💬</span>`;
    document.body.appendChild(chatBubble);
    chatBubble.addEventListener('click', openChatWindow);

    const whatsapp = document.createElement('a');
    whatsapp.href = `https://wa.me/+56989967350`;
    whatsapp.target = "_blank";
    whatsapp.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 64px;
      height: 64px;
      background: #25d366;
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 9999;
      text-decoration: none;
    `;
    whatsapp.innerHTML = `<span style="color: white; font-size: 32px;">📞</span>`;
    document.body.appendChild(whatsapp);
  };

  const openChatWindow = () => {
    if (document.getElementById('rigbot-window')) return;

    const container = document.createElement('div');
    container.id = 'rigbot-window';
    container.style.cssText = `
      position: fixed;
      bottom: 100px;
      right: 20px;
      width: 320px;
      height: 400px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      display: flex;
      flex-direction: column;
      z-index: 9999;
      overflow: hidden;
      border: 1px solid #ddd;
    `;

    container.innerHTML = `
      <div style="padding: 10px; background: #007bff; color: white; font-weight: bold;">
        Rigbot 🤖
      </div>
      <div id="rigbot-chat" style="flex: 1; padding: 10px; overflow-y: auto; font-family: Arial, sans-serif; font-size: 14px; background: #f9f9f9;"></div>
      <div style="display: flex; border-top: 1px solid #ddd;">
        <input type="text" id="rigbot-input" placeholder="Escribe algo..." style="flex: 1; border: none; padding: 10px; font-size: 14px;" />
        <button id="rigbot-send" style="background: #007bff; color: white; border: none; padding: 10px 14px; font-size: 14px; cursor: pointer;">Enviar</button>
      </div>
    `;
    document.body.appendChild(container);

    document.getElementById('rigbot-send').addEventListener('click', sendMessage);
    document.getElementById('rigbot-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') sendMessage();
    });

    addMessage("Hola 👋 Soy Rigbot, ¿en qué puedo ayudarte hoy?");
  };

  const addMessage = (text, from = 'bot') => {
    const chat = document.getElementById('rigbot-chat');
    if (!chat) return;
    const bubble = document.createElement('div');
    bubble.style.margin = '6px 0';
    bubble.style.padding = '8px 12px';
    bubble.style.borderRadius = '12px';
    bubble.style.maxWidth = '80%';
    bubble.style.wordBreak = 'break-word';
    bubble.style.background = from === 'bot' ? '#e6e6e6' : '#dcf8c6';
    bubble.style.alignSelf = from === 'bot' ? 'flex-start' : 'flex-end';
    bubble.textContent = text;
    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
  };

  const sendMessage = async () => {
    const input = document.getElementById('rigbot-input');
    const text = input?.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    input.value = '';
    try {
      addMessage('⏳ Un momento por favor...');
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
      const data = await response.json();
      document.getElementById('rigbot-chat')?.lastChild.remove();
      addMessage(data.response || 'Lo siento, no entendí eso.');
    } catch (err) {
      console.error('❌ Error en fetch Rigbot:', err);
      document.getElementById('rigbot-chat')?.lastChild.remove();
      addMessage('❌ Ocurrió un error al conectarme con Rigbot.');
    }
  };

  window.addEventListener('load', createBubbles);
})();
