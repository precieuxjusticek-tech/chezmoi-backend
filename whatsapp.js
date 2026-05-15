// ===================================================
// SERVICE WHATSAPP — BOT
// ===================================================
const fetch  = require("node-fetch");
const crypto = require("crypto");

// ===================================================
// NORMALISATION NUMÉRO CONGO
// ===================================================
const WHATSAPP_BOT_URL = process.env.WHATSAPP_BOT_URL;

function normaliserNumero(phone) {
  let num = String(phone || "").replace(/\D/g, "");
  if (num.length === 9 && (num.startsWith("06") || num.startsWith("05") || num.startsWith("04"))) {
    num = "242" + num;
  }
  if (num.length === 10 && num.startsWith("0")) {
    num = "242" + num.substring(1);
  }
  console.log(`[WhatsApp] Numéro normalisé: ${phone} → ${num}`);
  return num;
}

async function sendWhatsApp(phoneRaw, message) {
  const phone = normaliserNumero(phoneRaw);

  if (!phone || phone.length < 9) {
    console.warn(`[WhatsApp] ⚠️ Numéro invalide ignoré: ${phoneRaw}`);
    return;
  }

  try {
    const res = await fetch(WHATSAPP_BOT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, message })
    });

    const data = await res.json();

    if (data.success) {
      console.log(`[WhatsApp] ✅ Livré à ${phone}`);
    } else {
      console.error(`[WhatsApp] ❌ Échec pour ${phone}:`, data.error);
    }
  } catch (err) {
    console.error(`[WhatsApp] ❌ Erreur pour ${phone}: ${err.message}`);
  }
}

// ===================================================
// TOKEN SÉCURISÉ
// ===================================================

/**
 * Génère un token unique et sécurisé
 * @returns {string} token hex 64 caractères
 */
function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ===================================================
// COMPTEUR JOURNALIER PAR ANNONCE (Firestore)
// ===================================================

/**
 * Compte le nombre de demandes pour une annonce aujourd'hui
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} annonceId
 * @returns {Promise<number>} nombre de demandes aujourd'hui
 */
async function getCompteurJournalier(db, annonceId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { Timestamp } = require("firebase-admin").firestore;
  const todayTs = Timestamp.fromDate(today);

  const snap = await db.collection("contact_requests")
    .where("annonceId", "==", annonceId)
    .where("createdAt", ">=", todayTs)
    .get();

  return snap.size;
}

// ===================================================
// SAUVEGARDER ACTION REQUEST
// ===================================================

/**
 * Crée et sauvegarde une actionRequest en Firestore
 * Retourne le token généré
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} params
 * @returns {Promise<string>} token
 */
async function creerActionRequest(db, { annonceId, ownerUid, requesterUid }) {
  const { Timestamp } = require("firebase-admin").firestore;

  const token    = generateSecureToken();
  const now      = new Date();
  const expireAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24h

  await db.collection("action_requests").doc(token).set({
    token,
    annonceId,
    ownerUid,
    requesterUid,
    createdAt: Timestamp.fromDate(now),
    expireAt:  Timestamp.fromDate(expireAt),
    status:    "pending"
  });

  console.log(`[ActionRequest] ✅ Token créé pour annonce ${annonceId}: ${token.substring(0, 8)}...`);
  return token;
}

// ===================================================
// FORMATAGE DES 3 MESSAGES
// ===================================================

/**
 * Message propriétaire AVEC liens d'action
 */
function msgProprietaire({ nomProprio, titre, type_annonce, prix, ville, quartier, prenomDemandeur, urgence, budget, visite, message, score, token, compteur, commission, commissionChoice }) {
  const backendUrl = process.env.BACKEND_URL || "https://chezmoi-backend.onrender.com";

  const niveauLabel = score >= 71 ? "🟢 Profil A — Très sérieux"
                    : score >= 41 ? "🟡 Profil B — Sérieux"
                    :               "🔴 Profil C — Moyen";

  const urgenceLabel = {
    "IMMEDIAT":      "⚡ Immédiat",
    "1_2_JOURS":     "🔥 1–2 jours",
    "CETTE_SEMAINE": "📅 Cette semaine",
    "PLUS_TARD":     "👀 Exploration"
  }[urgence] || urgence;

  const budgetLabel = {
    "OK":       "✅ Budget confirmé",
    "NEGO":     "🤝 À négocier",
    "PAS_PRET": "⏳ Pas encore prêt"
  }[budget] || budget;

  const visiteLabel = {
    "AUJOURD_HUI":  "Aujourd'hui",
    "DEMAIN":       "Demain",
    "CETTE_SEMAINE":"Cette semaine",
    "PAS_SUR":      "Pas encore sûr"
  }[visite] || visite || "—";

  const ligneMessage = message && message.trim()
    ? `\n✍️ Message : "${message.trim()}"`
    : "";

  let ligneCommission = "";
  if (commission && commission.trim()) {
      const choixLabel = commissionChoice === "payer"
          ? "💰 Le locataire indique pouvoir payer les frais"
          : commissionChoice === "negocier"
          ? "🤝 Le locataire souhaite négocier les frais"
          : "";
      ligneCommission = `\n💼 Frais de commission : ${commission.trim()}${choixLabel ? `\n${choixLabel}` : ""}`;
  }

  return `Bonjour ${nomProprio} 👋

  ChezMoi vous transmet une demande de contact qualifiée pour votre annonce.

  ━━━━━━━━━━━━━━━
  🏠 VOTRE ANNONCE
  ━━━━━━━━━━━━━━━
  ${type_annonce || titre}
  📍 ${quartier}, ${ville}
  💰 ${Number(prix).toLocaleString("fr-FR")} XAF

  ━━━━━━━━━━━━━━━
  👤 PROFIL LOCATAIRE
  ━━━━━━━━━━━━━━━
  Prénom : ${prenomDemandeur}
  Emménagement : ${urgenceLabel}
  Visite : ${visiteLabel}
  Budget : ${budgetLabel}${ligneMessage}${ligneCommission}

  ━━━━━━━━━━━━━━━
  📊 ANALYSE CHEZMOI
  ━━━━━━━━━━━━━━━
  Score de sérieux : ${score}/100
  Niveau : ${niveauLabel}
  Demande analysée automatiquement par ChezMoi.

  ━━━━━━━━━━━━━━━
  👉 ACTION REQUISE
  ━━━━━━━━━━━━━━━
  ⚠️ Choisissez une option ci-dessous. Le numéro du locataire sera révélé uniquement si vous acceptez.

  🟢 J'ACCEPTE — voir son contact
  ${backendUrl}/api/whatsapp/action/accept?token=${token}

  🔒 BIEN DÉJÀ LOUÉ
  ${backendUrl}/api/whatsapp/action/loue?token=${token}

  ❌ PAS INTÉRESSÉ
  ${backendUrl}/api/whatsapp/action/refuse?token=${token}

  ⏳ Lien valide 24h · ${compteur}/5 demandes aujourd'hui
  ChezMoi — Immobilier au Congo 🇨🇬`;
}

function msgAdmin({ titre, type_annonce, annonceId, prix, nomProprio, numeroProprio, prenomDemandeur, numeroDemandeur, urgence, budget, visite, message, score, quartier, commission, commissionChoice }) {
  const ts = new Date().toLocaleString("fr-FR", { timeZone: "Africa/Brazzaville" });

  const niveauLabel = score >= 71 ? "A — Très sérieux 🟢"
                    : score >= 41 ? "B — Sérieux 🟡"
                    :               "C — Moyen 🔴";

  const urgenceLabel = {
    "IMMEDIAT":      "Immédiat ⚡",
    "1_2_JOURS":     "1–2 jours 🔥",
    "CETTE_SEMAINE": "Cette semaine 📅",
    "PLUS_TARD":     "Exploration 👀"
  }[urgence] || urgence;

  const budgetLabel = {
    "OK":       "Confirmé ✅",
    "NEGO":     "À négocier 🤝",
    "PAS_PRET": "Pas prêt ⏳"
  }[budget] || budget;

  const visiteLabel = {
    "AUJOURD_HUI":  "Aujourd'hui",
    "DEMAIN":       "Demain",
    "CETTE_SEMAINE":"Cette semaine",
    "PAS_SUR":      "Pas sûr"
  }[visite] || visite || "—";

  const ligneMessage = message && message.trim()
    ? `\nMessage libre : "${message.trim()}"`
    : "";

  let ligneCommissionAdmin = "";
  if (commission && commission.trim()) {
      const choixLabel = commissionChoice === "payer" ? "peut payer"
                      : commissionChoice === "negocier" ? "veut négocier" : "—";
      ligneCommissionAdmin = `\nCommission : ${commission.trim()} (${choixLabel})`;
  }

  return `🔔 NOUVELLE DEMANDE CHEZMOI
  ━━━━━━━━━━━━━━━
  📊 Score : ${score}/100 · Niveau ${niveauLabel}
  ⏱️ Emménagement : ${urgenceLabel}
  📍 Visite : ${visiteLabel}
  💰 Budget : ${budgetLabel}${ligneMessage}${ligneCommissionAdmin}
  🕐 Heure : ${ts}

  ━━━━━━━━━━━━━━━
  🏠 ANNONCE
  Bien : ${type_annonce || titre} (#${annonceId})
  Quartier : ${quartier}
  Prix : ${Number(prix).toLocaleString("fr-FR")} XAF

  ━━━━━━━━━━━━━━━
  👔 PROPRIO
  Nom : ${nomProprio}
  Tél : ${numeroProprio}

  ━━━━━━━━━━━━━━━
  👤 DEMANDEUR
  Prénom : ${prenomDemandeur}
  Tél : ${numeroDemandeur}`;
}

function msgDemandeur({
    prenomDemandeur,
    titre,
    type_annonce,
    quartier,
    prix,
    score,
    urgence,
    budget,
    visite
  }) {

  const niveauLabel = score >= 71
    ? "🟢 Profil prioritaire"
    : score >= 41
    ? "🟡 Profil correct"
    :"🟠 Profil en cours d’optimisation";

  const urgenceLabel = {
    "IMMEDIAT":      "⚡ Immédiat",
    "1_2_JOURS":     "🔥 1–2 jours",
    "CETTE_SEMAINE": "📅 Cette semaine",
    "PLUS_TARD":     "👀 Exploration"
  }[urgence] || urgence;

  const budgetLabel = {
    "OK":       "✅ Budget confirmé",
    "NEGO":     "🤝 À négocier",
    "PAS_PRET": "⏳ Pas encore prêt"
  }[budget] || budget;

  const visiteLabel = {
    "AUJOURD_HUI":   "Aujourd'hui",
    "DEMAIN":        "Demain",
    "CETTE_SEMAINE": "Cette semaine",
    "PAS_SUR":       "Pas encore sûr"
  }[visite] || visite;

  return `✅ Salut ${prenomDemandeur} !

  Ta demande ChezMoi a bien été transmise au propriétaire 📨

  ━━━━━━━━━━━━━━━
  🏠 ANNONCE
  ━━━━━━━━━━━━━━━
  🏠 ${type_annonce || titre}
  📍 ${quartier}
  💰 ${Number(prix).toLocaleString("fr-FR")} XAF

  ━━━━━━━━━━━━━━━
  📊 TON DOSSIER
  ━━━━━━━━━━━━━━━
  Indice de priorité : ${score}/100
  Niveau : ${niveauLabel}

  ⏱️ Emménagement : ${urgenceLabel}
  💰 Budget : ${budgetLabel}
  📅 Visite : ${visiteLabel}

  ━━━━━━━━━━━━━━━
  🧠 ANALYSE CHEZMOI
  ━━━━━━━━━━━━━━━
  Ton dossier a été analysé automatiquement avant transmission au propriétaire.

  Les propriétaires répondent généralement plus vite aux profils :
  ⚡ disponibles rapidement
  ✅ avec budget confirmé
  📅 avec date de visite claire

  ━━━━━━━━━━━━━━━
  🔒 SÉCURITÉ
  ━━━━━━━━━━━━━━━
  Aucun paiement n’est demandé avant validation du propriétaire.

  ⏳ Le propriétaire examine maintenant ta demande.
  ChezMoi te prévient dès qu'il répond 🤝`;
}

function msgAfterAccept({
  prenomDemandeur,
  type_annonce,
  nomProprio,
  numeroProprio,
  quartier,
  prix
  }) {
  return `🎉 Bonne nouvelle ${prenomDemandeur} !

  Le propriétaire a accepté votre demande sur ChezMoi ✅

  ━━━━━━━━━━━━━━━
  🏠 LOGEMENT
  ━━━━━━━━━━━━━━━
  🏠 ${type_annonce}
  📍 ${quartier}
  💰 ${Number(prix).toLocaleString("fr-FR")} XAF

  ━━━━━━━━━━━━━━━
  📞 CONTACT PROPRIÉTAIRE
  ━━━━━━━━━━━━━━━
  👤 ${nomProprio}
  📞 ${numeroProprio}

  ━━━━━━━━━━━━━━━
  ⚡ CONSEIL CHEZMOI
  ━━━━━━━━━━━━━━━
  Les bons logements partent souvent rapidement.

  Nous vous conseillons de :
  • confirmer votre intérêt rapidement
  • organiser une visite
  • éviter tout paiement avant visite réelle

  ━━━━━━━━━━━━━━━
  💬 MESSAGE SUGGÉRÉ
  ━━━━━━━━━━━━━━━
  Bonjour ${nomProprio}, c’est ${prenomDemandeur} via ChezMoi. Merci pour votre retour. Je suis disponible pour échanger concernant le logement à ${quartier}.

  ChezMoi — Immobilier au Congo 🇨🇬`;
}

function msgAfterAcceptProprio({
  nomProprio,
  prenomDemandeur,
  numeroDemandeur,
  quartier,
  prix
  }) {
  return `✅ Demande validée ${nomProprio}

  Le contact du locataire a été débloqué avec succès.

  ━━━━━━━━━━━━━━━
  👤 LOCATAIRE
  ━━━━━━━━━━━━━━━
  Prénom : ${prenomDemandeur}
  📞 ${numeroDemandeur}

  ━━━━━━━━━━━━━━━
  🏠 LOGEMENT
  ━━━━━━━━━━━━━━━
  📍 ${quartier}
  💰 ${Number(prix).toLocaleString("fr-FR")} XAF

  ━━━━━━━━━━━━━━━
  🤝 CONSEIL CHEZMOI
  ━━━━━━━━━━━━━━━
  Prenez quelques minutes pour :
  • confirmer la disponibilité du bien
  • fixer une visite claire
  • éviter toute demande d’argent suspecte

  ━━━━━━━━━━━━━━━
  💬 MESSAGE SUGGÉRÉ
  ━━━━━━━━━━━━━━━
  Bonjour ${prenomDemandeur}, c’est ${nomProprio} via ChezMoi. Votre demande pour le logement à ${quartier} a bien été acceptée. Quand êtes-vous disponible pour échanger ou visiter ?

  ⚠️ Toute activité frauduleuse entraîne une suppression immédiate du compte.`;
}

function msgAfterAcceptAdmin({
  annonceId,
  nomProprio,
  prenomDemandeur
  }) {
  return `✅ MATCH VALIDÉ CHEZMOI

  ━━━━━━━━━━━━━━━
  📄 ANNONCE
  ━━━━━━━━━━━━━━━
  ID : ${annonceId}

  ━━━━━━━━━━━━━━━
  🤝 MATCH
  ━━━━━━━━━━━━━━━
  👔 Propriétaire : ${nomProprio}
  👤 Demandeur : ${prenomDemandeur}

  Le contact a été débloqué avec succès.`;
}

function msgAfterLoue({
  prenomDemandeur,
  quartier,
  prix,
  type_annonce
  }) {
  return `😔 Bonjour ${prenomDemandeur},

  Le propriétaire nous informe que ce logement n’est malheureusement plus disponible.

  ━━━━━━━━━━━━━━━
  🏠 LOGEMENT
  ━━━━━━━━━━━━━━━
  🏠 ${type_annonce}
  📍 ${quartier}
  💰 ${Number(prix).toLocaleString("fr-FR")} XAF

  ━━━━━━━━━━━━━━━
  🔎 CHEZMOI CONTINUE
  ━━━━━━━━━━━━━━━
  Ne vous inquiétez pas 👍

  De nouveaux logements sont publiés régulièrement sur ChezMoi et nous continuerons à vous proposer d’autres opportunités adaptées à votre profil.

  ━━━━━━━━━━━━━━━
  💡 CONSEIL CHEZMOI
  ━━━━━━━━━━━━━━━
  Les meilleurs logements partent souvent rapidement.

  Pour augmenter vos chances :
  • gardez votre téléphone disponible
  • confirmez votre budget
  • soyez réactif pour les visites

  Merci de faire confiance à ChezMoi 🤝
  ChezMoi — Immobilier au Congo 🇨🇬`;
}

function msgAfterLoueAdmin({
    annonceId,
    nomProprio
  }) {
  return `🔒 LOGEMENT DÉJÀ LOUÉ

  ━━━━━━━━━━━━━━━
  📄 ANNONCE
  ━━━━━━━━━━━━━━━
  ID : ${annonceId}

  ━━━━━━━━━━━━━━━
  👔 PROPRIÉTAIRE
  ━━━━━━━━━━━━━━━
  ${nomProprio} a indiqué que le logement est déjà loué.

  La demande a été clôturée automatiquement.`;
}


function msgAfterRefuse({
    prenomDemandeur,
    quartier,
    prix,
    type_annonce
  }) {
  return `😕 Bonjour ${prenomDemandeur},

  Le propriétaire a choisi de ne pas donner suite à cette demande pour le moment.

  ━━━━━━━━━━━━━━━
  🏠 LOGEMENT
  ━━━━━━━━━━━━━━━
  🏠 ${type_annonce}
  📍 ${quartier}
  💰 ${Number(prix).toLocaleString("fr-FR")} XAF

  ━━━━━━━━━━━━━━━
  🔎 CHEZMOI CONTINUE
  ━━━━━━━━━━━━━━━
  Chaque propriétaire a ses propres critères de sélection et cela ne remet pas en cause votre profil 👍

  De nouvelles opportunités correspondant à votre recherche seront bientôt disponibles sur ChezMoi.

  ━━━━━━━━━━━━━━━
  💡 CONSEIL CHEZMOI
  ━━━━━━━━━━━━━━━
  Pour augmenter vos chances :
  • gardez un budget clair
  • soyez réactif aux demandes
  • proposez rapidement une visite

  Merci de faire confiance à ChezMoi 🤝
  ChezMoi — Immobilier au Congo 🇨🇬`;
}

function msgAfterRefuseAdmin({
    annonceId,
    nomProprio,
    prenomDemandeur
  }) {
  return `❌ DEMANDE REFUSÉE

  ━━━━━━━━━━━━━━━
  📄 ANNONCE
  ━━━━━━━━━━━━━━━
  ID : ${annonceId}

  ━━━━━━━━━━━━━━━
  🤝 DÉCISION
  ━━━━━━━━━━━━━━━
  👔 Propriétaire : ${nomProprio}
  👤 Demandeur : ${prenomDemandeur}

  Le propriétaire a refusé la demande de contact.`;
}

// ===================================================
// MESSAGE DE BIENVENUE APRÈS INSCRIPTION (selon rôle)
// ===================================================
function msgBienvenue({ prenom, role }) {
  const p = prenom || "cher utilisateur";

  if (role === "proprietaire") {
    return `🎉 Bienvenue sur ChezMoi, ${p}

    Votre compte propriétaire est prêt ✅

    Publiez votre bien en moins de 2 minutes :
    1️⃣ Cliquez sur "+"
    2️⃣ Ajoutez quartier, prix, photos et description
    3️⃣ Publiez et recevez des demandes directement sur WhatsApp

    📱 Important : enregistrez ce numéro sous "ChezMoi". C'est ici que vous recevrez les contacts des clients intéressés.

    Besoin d'aide ? Un bug ? Une idée pour améliorer ChezMoi ? Écrivez-nous ici directement.`;
  }

  if (role === "agent") {
    return `💼 Bienvenue sur ChezMoi, ${p}

    Votre espace agent est maintenant actif ✅

    Pour publier votre première annonce :
    1️⃣ Ouvrez "Chezmoi"
    2️⃣ Cliquez sur "+"
    3️⃣ Ajoutez les infos du bien puis publiez

    Les clients intéressés pourront vous contacter directement via WhatsApp.

    📱 Pensez à enregistrer ce numéro sous "ChezMoi" pour recevoir toutes les demandes.

    Une idée ou un problème ? Écrivez-nous ici, on répond rapidement.`;
  }

  // locataire (défaut)
  return `🏠 Bienvenue sur ChezMoi, ${p}

  Votre compte est prêt ✅

  Vous pouvez maintenant trouver des maisons et studios selon :
  📍 le quartier
  💰 votre budget
  🏡 le type de logement

  Comment commencer :
  1️⃣ Ouvrez "Chezmoi"
  2️⃣ Appliquez vos filtres
  3️⃣ Contactez directement le propriétaire ou l'agent via WhatsApp

  📱 Enregistrez ce numéro sous "ChezMoi" pour ne manquer aucune réponse.

  Besoin d'aide ou une suggestion ? Écrivez-nous ici directement.`;
}

// ===================================================
// MESSAGE DE RECONNEXION APRÈS CONNEXION (selon rôle)
// ===================================================
function msgConnexion({ prenom, role }) {
  const p = prenom || "cher utilisateur";

  if (role === "proprietaire") {
    return `👋 Bon retour sur ChezMoi, ${p}

    Votre tableau de bord est prêt ✅

    Consultez vos annonces, répondez aux demandes reçues et publiez de nouveaux biens en quelques minutes.

    📱 Ce numéro reste votre canal principal pour recevoir les messages des clients intéressés.

    Un problème ? Une idée d'amélioration ? Écrivez-nous ici directement.`;
  }

  if (role === "agent") {
    return `💼 Content de vous revoir, ${p}

    Votre espace agent est à jour ✅

    Profitez-en pour :
    1️⃣ Ajouter de nouveaux biens
    2️⃣ Répondre aux clients
    3️⃣ Relancer vos anciennes annonces

    📱 Gardez ce numéro enregistré sous "ChezMoi" pour recevoir toutes les demandes importantes.

    Une suggestion pour améliorer votre expérience ? Écrivez-nous ici directement.`;
  }

  // locataire (défaut)
  return `🏠 Bon retour sur ChezMoi, ${p}

  De nouvelles annonces sont disponibles depuis votre dernière visite ✅

  Ouvrez "Recherche", appliquez vos filtres par quartier et budget puis contactez directement les propriétaires ou agents via WhatsApp.

  📱 Pensez à enregistrer ce numéro sous "ChezMoi" pour recevoir rapidement les réponses.

  Un souci avec la recherche ou une suggestion ? Écrivez-nous ici directement.`;
}

module.exports = {
  sendWhatsApp,
  generateSecureToken,
  creerActionRequest,
  getCompteurJournalier,
  msgProprietaire,
  msgAdmin,
  msgDemandeur,
  // ← nouvelles
  msgAfterAccept,
  msgAfterAcceptProprio,
  msgAfterAcceptAdmin,
  msgAfterLoue,
  msgAfterLoueAdmin,
  msgAfterRefuse,
  msgAfterRefuseAdmin,
  msgBienvenue,
  msgConnexion
};