// rigbot-product/public/rigbot-widget-core.js
(() => {
  const PRODUCTION_CHAT_API_URL = 'https://rigbot-product.vercel.app/api/chat';
  const LOCAL_CHAT_API_URL = 'http://localhost:3001/api/chat'; 
  const IS_RIGSITE_WEB_RUNNING_LOCALLY = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  let backendUrl;

  if (window.NEXT_PUBLIC_RIGBOT_BACKEND_URL) { // Esta la setearía el script de carga de rigsite-web
    backendUrl = window.NEXT_PUBLIC_RIGBOT_BACKEND_URL; 
    if (!backendUrl.endsWith('/api/chat')) { 
        if(backendUrl.endsWith('/')) backendUrl += 'api/chat';
        else backendUrl += '/api/chat';
    }
    console.log("--- Rigbot Widget (vPureJS) --- Usando NEXT_PUBLIC_RIGBOT_BACKEND_URL para chat:", backendUrl);
  } else if (IS_RIGSITE_WEB_RUNNING_LOCALLY) {
    backendUrl = LOCAL_CHAT_API_URL;
    console.log("--- Rigbot Widget (vPureJS) --- rigsite-web en localhost, API objetivo (local de rigbot-product):", backendUrl);
  } else {
    backendUrl = PRODUCTION_CHAT_API_URL;
    console.log("--- Rigbot Widget (vPureJS) --- rigsite-web en producción, API objetivo (prod de rigbot-product):", backendUrl);
  }
  console.log("--- Rigbot Widget (vPureJS) --- Script EJECUTÁNDOSE.");

  let chatBubbleElement = null;
  let whatsappBubbleElement = null;
  let chatWindowElement = null;
  window.rigbotConversationHistory = []; // Siempre empezar historial vacío al cargar el core script
  let currentSessionStateForLeadCapture = null; 

  const initRigbot = () => {
    console.log("--- Rigbot Widget DEBUG --- initRigbot() FUE LLAMADA ---");
    createBubbles();
    if (!chatBubbleElement) chatBubbleElement = document.getElementById('rigbot-bubble-chat-custom');
    if (chatBubbleElement && !chatBubbleElement.dataset.listenerAttached) {
      chatBubbleElement.addEventListener('click', toggleChatWindow);
      chatBubbleElement.dataset.listenerAttached = 'true';
      console.log("--- Rigbot Widget DEBUG --- initRigbot(): Event listener de CLIC AÑADIDO a chatBubbleElement.");
    }
  };

  const createBubbles = () => {
    // ... (código de createBubbles SIN CAMBIOS, pero usando window.RIGBOT_WHATSAPP_NUMBER para el href)
    console.log("--- Rigbot Widget DEBUG --- createBubbles() FUE LLAMADA ---");
    if (!document.getElementById('rigbot-bubble-chat-custom')) {
      console.log("--- Rigbot Widget DEBUG --- createBubbles(): Creando burbuja de CHAT.");
      chatBubbleElement = document.createElement('div');
      chatBubbleElement.id = 'rigbot-bubble-chat-custom';
      chatBubbleElement.setAttribute('aria-label', 'Abrir chat con Rigbot');
      chatBubbleElement.title = 'Chatear con Rigbot';
      chatBubbleElement.style.cssText = `
        position: fixed; bottom: 20px; right: 90px; width: 60px; height: 60px;
        background-color: #007bff; color: white; border-radius: 50%;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25); display: flex; align-items: center;
        justify-content: center; cursor: pointer; z-index: 9998;
        transition: transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out;
      `;
      chatBubbleElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
      chatBubbleElement.onmouseenter = () => { chatBubbleElement.style.transform = 'scale(1.1)'; chatBubbleElement.style.boxShadow = '0 6px 16px rgba(0,0,0,0.3)'; };
      chatBubbleElement.onmouseleave = () => { chatBubbleElement.style.transform = 'scale(1)'; chatBubbleElement.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)'; };
      document.body.appendChild(chatBubbleElement);
    } else {
      chatBubbleElement = document.getElementById('rigbot-bubble-chat-custom');
    }

    if (!document.getElementById('rigbot-bubble-whatsapp-custom')) {
      whatsappBubbleElement = document.createElement('a');
      whatsappBubbleElement.id = 'rigbot-bubble-whatsapp-custom';
      const whatsappNumberToUse = window.RIGBOT_WHATSAPP_NUMBER || "+56900000000"; // Usar el de la config o un default
      whatsappBubbleElement.href = `https://wa.me/${whatsappNumberToUse.replace(/\D/g, '')}`; 
      whatsappBubbleElement.target = "_blank";
      whatsappBubbleElement.setAttribute('aria-label', 'Contactar por WhatsApp');
      whatsappBubbleElement.title = 'Contactar por WhatsApp';
      whatsappBubbleElement.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px;
        background-color: #25D366; color: white; border-radius: 50%;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25); display: flex; align-items: center;
        justify-content: center; cursor: pointer; z-index: 9998; text-decoration: none;
        transition: transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out;
      `;
      whatsappBubbleElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`;
      whatsappBubbleElement.onmouseenter = () => { whatsappBubbleElement.style.transform = 'scale(1.1)'; whatsappBubbleElement.style.boxShadow = '0 6px 16px rgba(0,0,0,0.3)'; };
      whatsappBubbleElement.onmouseleave = () => { whatsappBubbleElement.style.transform = 'scale(1)'; whatsappBubbleElement.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)'; };
      document.body.appendChild(whatsappBubbleElement);
    } else {
      whatsappBubbleElement = document.getElementById('rigbot-bubble-whatsapp-custom');
    }
  };
  
  const toggleChatWindow = () => {
    if (chatWindowElement && document.body.contains(chatWindowElement)) {
      closeChatWindow();
    } else {
      openChatWindow();
    }
  };
  
  const openChatWindow = () => {
    if (document.getElementById('rigbot-window-custom')) return;

    // Resetear estado y historial para una nueva "sesión" de chat visual
    window.rigbotConversationHistory = []; 
    if (window.RIGBOT_LEAD_CAPTURE_INITIALLY_OFFERED === true) { // Comprobar explícitamente true
        currentSessionStateForLeadCapture = { 
            leadCapture: { step: 'offered', data: {}, offeredInTurn: 0, declinedInSession: false },
            turnCount: 0 
        };
        console.log("--- Rigbot Widget DEBUG --- openChatWindow(): Initial offer was made by widget. sessionState.leadCapture.step set to 'offered'.");
    } else {
        currentSessionStateForLeadCapture = null; // O el estado inicial por defecto si no se ofreció
        console.log("--- Rigbot Widget DEBUG --- openChatWindow(): No initial lead offer by widget. sessionState es null.");
    }
    
    chatWindowElement = document.createElement('div');
    // ... (código de creación de chatWindowElement y listeners SIN CAMBIOS)...
    chatWindowElement.id = 'rigbot-window-custom';
    chatWindowElement.style.cssText = `
      position: fixed; bottom: 90px; right: 20px; width: 350px; max-width: 90vw;
      height: 500px; max-height: 70vh; background-color: #ffffff; border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.2); display: flex; flex-direction: column;
      z-index: 10000; overflow: hidden; border: 1px solid #e0e0e0;
      font-family: 'Roboto', 'Segoe UI', Arial, sans-serif; opacity: 0;
      transform: translateY(20px); transition: opacity 0.3s ease-out, transform 0.3s ease-out;
    `;
    requestAnimationFrame(() => {
      if (chatWindowElement) {
        chatWindowElement.style.opacity = '1';
        chatWindowElement.style.transform = 'translateY(0)';
      }
    });
    chatWindowElement.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background-color: #007bff; color: white; border-top-left-radius: 11px; border-top-right-radius: 11px;">
        <span style="font-weight: bold; font-size: 16px;">Rigbot Asistente</span>
        <button id="rigbot-close-custom-btn" aria-label="Cerrar chat" style="background: none; border: none; color: white; font-size: 24px; cursor: pointer; line-height: 1;">×</button>
      </div>
      <div id="rigbot-chat-messages-custom" style="flex: 1; padding: 12px; overflow-y: auto; background-color: #f7f9fc; display: flex; flex-direction: column; gap: 8px;"></div>
      <div style="display: flex; border-top: 1px solid #e0e0e0; padding: 8px; background-color: #f0f0f0;">
        <input type="text" id="rigbot-input-custom" placeholder="Escribe tu mensaje..." style="flex: 1; border: 1px solid #ccc; border-radius: 20px; padding: 10px 15px; font-size: 14px; outline: none; margin-right: 8px;" />
        <button id="rigbot-send-custom-btn" aria-label="Enviar mensaje" style="background-color: #007bff; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
      </div>
    `;
    document.body.appendChild(chatWindowElement);

    document.getElementById('rigbot-close-custom-btn').addEventListener('click', closeChatWindow);
    document.getElementById('rigbot-send-custom-btn').addEventListener('click', sendMessage);
    document.getElementById('rigbot-input-custom').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    
    // Usar el mensaje inicial inyectado por el loader script
    const firstBotMessage = window.RIGBOT_INITIAL_GREETING || "Hola 👋 Soy Rigbot, tu asistente virtual. ¿En qué puedo ayudarte hoy?";
    addMessageToChat(firstBotMessage, 'bot');
    window.rigbotConversationHistory.push({ role: "assistant", content: firstBotMessage });

    const inputField = document.getElementById('rigbot-input-custom');
    if (inputField) inputField.focus();
  };

  const closeChatWindow = () => {
    // ... (código de closeChatWindow SIN CAMBIOS) ...
    console.log("--- Rigbot Widget DEBUG --- closeChatWindow() FUE LLAMADA.");
    if (chatWindowElement) {
      chatWindowElement.style.opacity = '0';
      chatWindowElement.style.transform = 'translateY(20px)';
      setTimeout(() => {
        if (chatWindowElement && document.body.contains(chatWindowElement)) {
          chatWindowElement.remove();
        }
        chatWindowElement = null; 
        console.log("--- Rigbot Widget DEBUG --- closeChatWindow(): Ventana eliminada, chatWindowElement es NULL.");
      }, 300);
    } else {
      console.log("--- Rigbot Widget DEBUG --- closeChatWindow(): No había chatWindowElement para cerrar.");
    }
  };

  const addMessageToChat = (text, sender = 'bot', isLoading = false) => {
    // ... (código de addMessageToChat SIN CAMBIOS) ...
    const chatMessagesContainer = document.getElementById('rigbot-chat-messages-custom');
    if (!chatMessagesContainer && chatWindowElement) {
      console.error("--- Rigbot Widget ERROR --- addMessageToChat: Contenedor 'rigbot-chat-messages-custom' NO ENCONTRADO dentro de chatWindowElement.");
      return;
    }
    if (!chatMessagesContainer) return;

    const existingTypingIndicator = document.getElementById('rigbot-typing-indicator');
    if (existingTypingIndicator && !isLoading) {
      existingTypingIndicator.remove();
    }
    
    const messageBubble = document.createElement('div');
    messageBubble.classList.add('rigbot-message-bubble');
    messageBubble.style.cssText = `
      padding: 10px 14px; border-radius: 18px; margin-bottom: 4px; max-width: 75%;
      word-wrap: break-word; line-height: 1.4; font-size: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    `;
    if (sender === 'user') {
      messageBubble.style.backgroundColor = '#007bff'; messageBubble.style.color = 'white';
      messageBubble.style.marginLeft = 'auto'; messageBubble.style.borderBottomRightRadius = '4px';
    } else {
      messageBubble.style.backgroundColor = '#e9ecef'; messageBubble.style.color = '#333';
      messageBubble.style.marginRight = 'auto'; messageBubble.style.borderBottomLeftRadius = '4px';
    }
    if (isLoading) {
      messageBubble.id = 'rigbot-typing-indicator';
      messageBubble.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 20px;"><div class="rigbot-dot-flashing" style="width: 6px; height: 6px; margin: 0 2px; background-color: #888; border-radius: 50%; animation: rigbotDotFlashing 1s infinite linear alternate;"></div><div class="rigbot-dot-flashing" style="width: 6px; height: 6px; margin: 0 2px; background-color: #888; border-radius: 50%; animation: rigbotDotFlashing 1s infinite linear alternate; animation-delay: 0.2s;"></div><div class="rigbot-dot-flashing" style="width: 6px; height: 6px; margin: 0 2px; background-color: #888; border-radius: 50%; animation: rigbotDotFlashing 1s infinite linear alternate; animation-delay: 0.4s;"></div></div>`;
      if (!document.getElementById('rigbot-animation-styles')) {
        const styleSheet = document.createElement("style"); styleSheet.id = 'rigbot-animation-styles';
        styleSheet.innerText = `@keyframes rigbotDotFlashing { 0% { background-color: #888; } 50%, 100% { background-color: #ccc; } }`;
        document.head.appendChild(styleSheet);
      }
    } else {
      messageBubble.textContent = text;
    }
    chatMessagesContainer.appendChild(messageBubble);
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
  };

  const sendMessage = async () => {
    // ... (inicio de sendMessage SIN CAMBIOS) ...
    console.log("--- Rigbot Widget DEBUG --- sendMessage(): ¡FUNCIÓN INICIADA! ---");
    const currentClientId = window.RIGBOT_CLIENT_ID || 'demo-client'; 
    const claveFromWindow = window.RIGBOT_CLAVE || null; 
    
    const inputElement = document.getElementById('rigbot-input-custom'); 
    
    if (!inputElement) { /* ... manejo de error ... */ return; }

    const text = inputElement.value.trim(); 
    if (!text) { /* ... manejo de texto vacío ... */ return; }

    addMessageToChat(text, 'user');
    inputElement.value = ''; 
    inputElement.focus();   
    addMessageToChat('', 'bot', true);

    if (window.rigbotConversationHistory[window.rigbotConversationHistory.length -1]?.role !== 'user' || 
        window.rigbotConversationHistory[window.rigbotConversationHistory.length -1]?.content !== text) {
        window.rigbotConversationHistory.push({ role: "user", content: text });
    }
    
    const payload = {
        message: text,
        clientId: currentClientId,
        clave: claveFromWindow,
        sessionId: window.RIGBOT_SESSION_ID || `widget_session_${Date.now()}`, 
        conversationHistory: window.rigbotConversationHistory,
        sessionState: currentSessionStateForLeadCapture // Envía el estado actual
    };
    console.log("📦 Payload enviado a API:", JSON.stringify(payload, null, 2));
    
    try {
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const existingTypingIndicator = document.getElementById('rigbot-typing-indicator');
      if (existingTypingIndicator) { existingTypingIndicator.remove(); }

      if (!response.ok) { /* ... manejo de error de respuesta ... */ 
          let errorData; try { errorData = await response.json(); } catch (e) { /* No JSON */ }
          console.error('Error en la respuesta del servidor:', response.status, errorData);
          const botErrorMessage = errorData?.error || 'Hubo un problema con la respuesta del servidor.';
          addMessageToChat(botErrorMessage, 'bot');
          window.rigbotConversationHistory.push({ role: "assistant", content: botErrorMessage });
          currentSessionStateForLeadCapture = errorData?.sessionState || currentSessionStateForLeadCapture; // Intentar mantener el estado
          return;
      }
      const data = await response.json();
      console.log("--- Rigbot Widget DEBUG --- sendMessage(): Datos recibidos del backend:", JSON.stringify(data, null, 2)); 
      
      const botResponseText = data.response || 'Lo siento, no he podido procesar eso en este momento.';
      currentSessionStateForLeadCapture = data.sessionState; // Guardar el estado actualizado

      if (currentSessionStateForLeadCapture) {
        console.log("--- Rigbot Widget DEBUG --- sendMessage(): Nuevo sessionState guardado:", JSON.stringify(currentSessionStateForLeadCapture, null, 2));
      }
      
      addMessageToChat(botResponseText, 'bot');
      window.rigbotConversationHistory.push({ role: "assistant", content: botResponseText });

    } catch (err) { /* ... manejo de error de fetch ... */ 
        console.error('❌ Error en fetch Rigbot:', err);
        const existingTypingIndicator = document.getElementById('rigbot-typing-indicator');
        if (existingTypingIndicator) { existingTypingIndicator.remove(); }
        const networkErrorMsg = '❌ Ups, parece que hay un problema de conexión. Intenta de nuevo.';
        addMessageToChat(networkErrorMsg, 'bot');
        window.rigbotConversationHistory.push({ role: "assistant", content: networkErrorMsg });
    }
  };
  
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initRigbot();
  } else {
    window.addEventListener('DOMContentLoaded', initRigbot);
  }
})();