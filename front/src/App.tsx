/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import { ChatPage, type ChatMessage } from './pages/ChatPage';
import { VoiceRealtimePage } from './pages/VoiceRealtimePage';

export default function App() {
  const [view, setView] = useState<'chat' | 'voice'>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId] = useState(() => `c-${crypto.randomUUID()}`);
  const pendingVoiceMessagesRef = useRef<ChatMessage[]>([]);

  const handleVoiceAssistantReply = useCallback((assistantText: string, userTranscript?: string) => {
    const assistant = assistantText.trim();
    if (!assistant) return;
    const user = userTranscript?.trim() ?? '';
    if (user) {
      pendingVoiceMessagesRef.current.push(
        { id: crypto.randomUUID(), role: 'user', content: user, voice: true },
        { id: crypto.randomUUID(), role: 'assistant', content: assistant }
      );
    } else {
      pendingVoiceMessagesRef.current.push(
        { id: crypto.randomUUID(), role: 'assistant', content: assistant }
      );
    }
  }, []);

  const openVoice = useCallback(() => {
    pendingVoiceMessagesRef.current = [];
    setView('voice');
  }, []);

  const closeVoice = useCallback(() => {
    if (pendingVoiceMessagesRef.current.length > 0) {
      setMessages((prev) => [...prev, ...pendingVoiceMessagesRef.current]);
      pendingVoiceMessagesRef.current = [];
    }
    setView('chat');
  }, []);

  if (view === 'voice') {
    return (
      <VoiceRealtimePage
        onBack={closeVoice}
        conversationId={conversationId}
        onVoiceAssistantReply={handleVoiceAssistantReply}
      />
    );
  }

  return (
    <ChatPage
      onOpenVoice={openVoice}
      messages={messages}
      setMessages={setMessages}
      conversationId={conversationId}
    />
  );
}
