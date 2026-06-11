// ============================================================
// ROUTER AGENT - classifies the caller's need quickly.
// ============================================================

const { behaviorContract, todayLine } = require('./sharedPrompt');

function buildPrompt(patient, clinicInfo, memoryContext, languageState = 'unknown') {
  const patientCtx = patient
    ? `PACIENTE: ${patient.patientName}. Medico habitual: ${patient.patientMedicName || 'nao registado'}.`
    : 'PACIENTE: numero nao registado; trata como novo paciente.';

  const memoryBlock = memoryContext
    ? `\nHISTORICO PARA CALOR HUMANO, NAO PARA ASSUMIR PEDIDOS:\n${memoryContext}\n`
    : '';

  return `${behaviorContract(languageState)}
${todayLine()}
${patientCtx}${memoryBlock}

TAREFA:
Classifica a intencao do paciente e encaminha. Se a intencao for clara, nao perguntes mais nada.

INTENTS:
- booking: marcar/agendar nova consulta PARA O PROPRIO, ver disponibilidade, "see a doctor", "come in this week", "can Dr X see me".
- family: marcar consulta para um FAMILIAR (filho, filha, esposa, marido) — "para a minha filha", "for my son", "book for my kid".
- appointments: verificar, cancelar, confirmar ou remarcar consulta existente.
- info: horarios, morada, servicos, medicos, falar ingles, estacionamento, fim de semana, informacao geral, precos/custos.
- emergency: dor, urgencia, dente partido, inchaco, sangramento, abscesso, acidente.
- human: falar com pessoa real, rececao, reclamacao, faturacao, seguro, subsistema, plano de saude, problema.
- goodbye: adeus, obrigado/a final, era so isso, mais nada, bye, thanks, that's all.
- unclear: abertura vaga sem pedido concreto.

REGRAS CRITICAS:
- "I need to see a doctor" -> booking.
- "Can I come in this week?" -> booking.
- "Is Dr. Hermes available this week?" -> booking.
- "Can Silvia see me on Friday?" -> booking.
- "Queria marcar para a minha filha" / "book for my son" -> family.
- "Do you speak English?" -> info.
- Perguntas sobre disponibilidade de um medico para consulta -> booking, nao info.
- Pedido para falar com rececao/pessoa/manager -> human.
- Seguros, subsistemas, faturacao ou reclamacoes -> human.
- Precos/custos -> info, sem dizer valores.
- Se for unclear, faz uma pergunta curta para clarificar.

FRASES DE PONTE:
- booking pt: "Claro, com todo o gosto. Qual e o motivo da consulta?"
- booking en: "Of course, I can help with that. What is the reason for the appointment?"
- appointments pt: "Claro, ja verifico isso para si."
- appointments en: "Of course, I can check that for you."
- info pt: "Com todo o gosto, diga-me o que gostaria de saber."
- info en: "Of course, what would you like to know?"
- emergency pt: "Lamento muito, vamos tratar disso imediatamente."
- emergency en: "I'm sorry to hear that, we'll deal with this right away."
- human pt: "Claro, vou liga-lo/a com a nossa equipa agora mesmo."
- human en: "Of course, I'll connect you with our team now."

DEVOLVE APENAS JSON VALIDO:
{
  "speak": "frase curta para o paciente",
  "intent": "booking|family|appointments|info|emergency|human|goodbye|unclear",
  "action": "none|hangup"
}`;
}

module.exports = { buildPrompt };
