// ============================================================
// VICKI AI — Clinic Knowledge Base (lightweight RAG for the info agent)
// ============================================================
// Source: institutovilasboas.pt (crawled 2026-06-11). This is a CURATED,
// grounded knowledge base — facts only, no invented prices or claims.
//
// Why not a vector DB? The site is ~10 static pages. A keyword retriever over
// curated entries is faster (no embedding round-trip, < 1ms), fully grounded
// (the LLM only sees real facts), and trivial to refresh. If the KB grows large
// later, swap retrieve() for an embedding search — the interface stays the same.
//
// ANTI-HALLUCINATION (per CLAUDE.md):
//   - Every entry is a real fact from the website or confirmed clinic data.
//   - NO prices. Pricing policy = free evaluation consultation (handled in prompt).
//   - When nothing matches, retrieve() returns [] and the agent falls back to
//     "let me have someone follow up" / transfer.
//
// TODO: re-crawl institutovilasboas.pt whenever services/team change.
// ============================================================

// Each entry: { id, tags:[keywords for matching], pt, en }
// `pt`/`en` are SHORT, voice-ready fact strings (no markdown, spoken-friendly).
const KB = [
  // ── Clinic identity & locations ──────────────────────────────────────────
  {
    id: 'about',
    tags: ['about', 'clinic', 'who are you', 'history', 'sobre', 'clinica', 'quem', 'fundada', 'fundadores'],
    pt: 'O Instituto Vilas Boas foi fundado em 2021 pela Doutora Carla Vilas Boas e pela Telma César. É uma clínica de medicina dentária, estética e bem-estar, com equipa multidisciplinar e tecnologia avançada.',
    en: 'Instituto Vilas Boas was founded in 2021 by Doctor Carla Vilas Boas and Telma César. It is a dental medicine, aesthetics and wellness clinic with a multidisciplinary team and advanced technology.',
  },
  {
    id: 'locations',
    tags: ['location', 'where', 'address', 'clinics', 'quarteira', 'loule', 'morada', 'onde', 'fica', 'clinicas', 'localizacao'],
    pt: 'Temos duas clínicas: em Loulé, na Avenida 25 de Abril, e em Quarteira, na Rua Diogo Cão, número 5. Há uma terceira a abrir em breve.',
    en: 'We have two clinics: in Loulé on Avenida 25 de Abril, and in Quarteira on Rua Diogo Cão, number 5. A third location is opening soon.',
  },
  {
    id: 'hours',
    tags: ['hours', 'open', 'opening', 'time', 'when open', 'horario', 'horas', 'aberto', 'abre', 'fecha', 'fim de semana', 'weekend'],
    pt: 'Estamos abertos de segunda a sexta-feira, das nove e meia da manhã às sete e meia da tarde. Encerramos ao fim de semana e em feriados.',
    en: 'We are open Monday to Friday, from nine thirty in the morning to seven thirty in the evening. We are closed on weekends and public holidays.',
  },
  {
    id: 'contact_loule',
    tags: ['phone', 'number', 'call', 'contact', 'loule', 'telefone', 'numero', 'contacto'],
    pt: 'O contacto de Loulé é o duzentos e oitenta e nove, quatro dois dois, dois seis nove. O telemóvel é o nove seis dois, quatro três dois, sete seis um.',
    en: 'The Loulé number is two eight nine, four two two, two six nine. The mobile is nine six two, four three two, seven six one.',
  },
  {
    id: 'contact_quarteira',
    tags: ['phone quarteira', 'quarteira number', 'contacto quarteira', 'telefone quarteira'],
    pt: 'O contacto de Quarteira é o duzentos e oitenta e nove, zero um seis, oito dois sete. O telemóvel é o nove dois seis, sete três sete, nove nove nove.',
    en: 'The Quarteira number is two eight nine, zero one six, eight two seven. The mobile is nine two six, seven three seven, nine nine nine.',
  },
  {
    id: 'languages',
    tags: ['language', 'english', 'speak', 'falam', 'ingles', 'lingua', 'idioma'],
    pt: 'A nossa equipa fala português e também atende pacientes em inglês.',
    en: 'Our team speaks Portuguese and also assists patients in English.',
  },

  // ── Services ─────────────────────────────────────────────────────────────
  {
    id: 'svc_hygiene',
    tags: ['cleaning', 'hygiene', 'scaling', 'tartar', 'limpeza', 'higiene', 'destartarizacao', 'destartarização'],
    pt: 'A higiene oral inclui destartarização, ou seja, remoção de tártaro, e aconselhamento sobre hábitos de higiene. É a base para prevenir doenças orais.',
    en: 'Oral hygiene includes scaling — tartar removal — and guidance on hygiene habits. It is the foundation for preventing oral disease.',
  },
  {
    id: 'svc_implants',
    tags: ['implant', 'implants', 'implante', 'implantes', 'carga imediata', 'immediate load', 'missing tooth', 'dente em falta'],
    pt: 'A implantologia repõe um ou mais dentes em falta com implantes de titânio que funcionam como raiz. Oferecemos implantes de carga imediata e implantes personalizados.',
    en: 'Implantology replaces one or more missing teeth with titanium implants that act as the root. We offer immediate-load implants and personalised implants.',
  },
  {
    id: 'svc_ortho',
    tags: ['ortho', 'orthodontics', 'braces', 'aligner', 'aligners', 'invisalign', 'ortodontia', 'aparelho', 'alinhador', 'alinhadores', 'invisivel'],
    pt: 'Fazemos ortodontia com aparelho fixo e com alinhadores invisíveis. Corrige dentes desalinhados e problemas de mordida que afetam a fala e a mastigação.',
    en: 'We offer orthodontics with fixed braces and with invisible aligners. It corrects misaligned teeth and bite problems that affect speech and chewing.',
  },
  {
    id: 'svc_aesthetic_dental',
    tags: ['whitening', 'veneer', 'veneers', 'cosmetic', 'branqueamento', 'faceta', 'facetas', 'estetica dentaria', 'estética', 'sorriso'],
    pt: 'A medicina dentária estética inclui branqueamento, facetas e harmonização do sorriso, devolvendo a beleza natural dos dentes com função e estética.',
    en: 'Cosmetic dentistry includes whitening, veneers and smile harmonisation, restoring the natural beauty of the teeth with both function and aesthetics.',
  },
  {
    id: 'svc_endo',
    tags: ['root canal', 'endodontics', 'devitalization', 'nerve', 'endodontia', 'desvitalizacao', 'canal', 'nervo'],
    pt: 'A endodontia, ou tratamento de canal, limpa o interior do dente comprometido e sela-o, eliminando a dor e evitando muitas vezes a extração.',
    en: 'Endodontics, or root canal treatment, cleans the inside of a compromised tooth and seals it, eliminating pain and often avoiding extraction.',
  },
  {
    id: 'svc_resto',
    tags: ['restoration', 'filling', 'fillings', 'cavity', 'decay', 'restauracao', 'restauração', 'obturacao', 'carie', 'cárie', 'chumbo'],
    pt: 'As restaurações recuperam dentes danificados por cárie, desgaste ou trauma, devolvendo a função e a estética, com anestesia local e evitando a extração sempre que possível.',
    en: 'Restorations repair teeth damaged by decay, wear or trauma, restoring function and aesthetics, with local anaesthesia and avoiding extraction whenever possible.',
  },
  {
    id: 'svc_perio',
    tags: ['gum', 'gums', 'periodontal', 'gingivitis', 'periodontitis', 'gengiva', 'gengivas', 'periodontologia', 'gengivite'],
    pt: 'A periodontologia trata as doenças das gengivas e do suporte do dente, como a gengivite e a periodontite, com foco na prevenção e remoção de placa.',
    en: 'Periodontology treats diseases of the gums and tooth-supporting tissue, such as gingivitis and periodontitis, focusing on prevention and plaque removal.',
  },
  {
    id: 'svc_pediatric',
    tags: ['child', 'children', 'kid', 'kids', 'baby', 'pediatric', 'crianca', 'criança', 'filho', 'filha', 'bebe', 'bebé', 'odontopediatria'],
    pt: 'Temos odontopediatria para bebés, crianças e adolescentes. A primeira visita é recomendada entre os seis meses e um ano. Usamos técnicas que afastam o medo das crianças.',
    en: 'We offer pediatric dentistry for babies, children and adolescents. The first visit is recommended between six months and one year old. We use techniques that ease children’s fears.',
  },
  {
    id: 'svc_facial',
    tags: ['facial', 'harmonization', 'aesthetic', 'botox', 'filler', 'estetica facial', 'harmonizacao', 'harmonização', 'rugas', 'preenchimento'],
    pt: 'A estética facial e harmonização é feita pela Doutora Aline, na clínica de Quarteira. Para isso, dou seguimento para a equipa agendar nessa clínica.',
    en: 'Facial aesthetics and harmonisation are done by Doctor Aline, at the Quarteira clinic. For that, I’ll pass it to our team to schedule at that clinic.',
  },
  {
    id: 'svc_other',
    tags: ['osteopathy', 'podiatry', 'podologist', 'osteopatia', 'podologia', 'podologista'],
    pt: 'Além da medicina dentária e estética, também temos osteopatia e podologia.',
    en: 'Besides dental medicine and aesthetics, we also offer osteopathy and podiatry.',
  },

  // ── Team ─────────────────────────────────────────────────────────────────
  {
    id: 'team',
    tags: ['doctor', 'doctors', 'dentist', 'team', 'who works', 'medico', 'médico', 'medicos', 'médicos', 'dentista', 'equipa', 'doutora', 'doutor'],
    pt: 'A nossa equipa clínica inclui a Doutora Carla Vilas Boas, diretora clínica com mais de dezoito anos de experiência, a Doutora Carolina Alcântara, o Doutor Hermes Monsalve, a Doutora Nadine Guerreiro, a Doutora Silvia Soares e a Doutora Beatriz Café, entre outros.',
    en: 'Our clinical team includes Doctor Carla Vilas Boas, clinical director with over eighteen years of experience, Doctor Carolina Alcântara, Doctor Hermes Monsalve, Doctor Nadine Guerreiro, Doctor Silvia Soares and Doctor Beatriz Café, among others.',
  },
];

// ── Retriever ───────────────────────────────────────────────────────────────
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Retrieve the most relevant KB entries for a free-text question.
 * Scores by number of tag keywords found in the text. Returns up to `limit`
 * entries (highest score first). Empty array when nothing matches —
 * the caller should then fall back to "I'll have someone follow up".
 *
 * @param {string} text     patient's question
 * @param {object} [opts]   { limit=2, lang='pt' }
 * @returns {{id,text,score}[]}
 */
function retrieve(text, { limit = 2, lang = 'pt' } = {}) {
  const t = normalize(text);
  if (!t) return [];
  const en = lang === 'en';
  const scored = KB.map(entry => {
    let score = 0;
    for (const tag of entry.tags) {
      if (t.includes(normalize(tag))) score += normalize(tag).length; // longer match = stronger
    }
    return { id: entry.id, text: en ? entry.en : entry.pt, score };
  }).filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Render retrieved facts as a compact block to inject into the info prompt. */
function knowledgeBlock(text, lang = 'pt') {
  const hits = retrieve(text, { limit: 2, lang });
  if (!hits.length) return '';
  return hits.map(h => `- ${h.text}`).join('\n');
}

module.exports = { KB, retrieve, knowledgeBlock };
