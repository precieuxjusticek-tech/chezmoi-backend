/* ======== process.env ======== */
require("dotenv").config();
/* ===================================================== */
/* ================= IMPORTS =========================== */
/* ===================================================== */
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // pour Imgbb
const nodemailer = require("nodemailer"); // pour email
const webpush = require("web-push");
const cloudinary = require("cloudinary").v2;
const {
  sendWhatsApp, creerActionRequest, getCompteurJournalier,
  msgProprietaire, msgAdmin, msgDemandeur,
  msgAfterAccept, msgAfterAcceptProprio, msgAfterAcceptAdmin,
  msgAfterLoue, msgAfterLoueAdmin,
  msgAfterRefuse, msgAfterRefuseAdmin
} = require("./whatsapp");

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Config VAPID (génère une fois avec : npx web-push generate-vapid-keys)
webpush.setVapidDetails(
  "mailto:ton@email.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);


/* ===================================================== */
/* ================= INITIALISATION ==================== */
/* ===================================================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

const multer = require("multer");

const path = require("path");
const fs = require("fs");

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = "./uploads"; // dossier temporaire
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${ext}`);
    }
});

// ================= CONFIG MULTER =================

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // max 20MB par fichier
    fileFilter: (req, file, cb) => {
        if(file.mimetype.startsWith("image/")){
            cb(null, true);
        } else {
            cb(new Error("Seules les images sont autorisées"));
        }
    }
});

// ===== SAUVEGARDER LA SUBSCRIPTION =====
app.post("/api/push/subscribe", async (req, res) => {
  const { uid, subscription } = req.body;
  if (!uid || !subscription) return res.status(400).json({ message: "Données manquantes" });

  try {
    await db.collection("push_subscriptions").doc(uid).set({
      uid,
      subscription,
      updatedAt: admin.firestore.Timestamp.now()
    });
    res.json({ message: "Subscription enregistrée" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ===== SUPPRIMER LA SUBSCRIPTION =====
app.delete("/api/push/subscribe/:uid", async (req, res) => {
  try {
    await db.collection("push_subscriptions").doc(req.params.uid).delete();
    res.json({ message: "Subscription supprimée" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ===== ENVOYER UNE NOTIFICATION À UN USER =====
// Fonction interne réutilisable
async function envoyerNotificationPush(uid, payload) {
  try {
    const doc = await db.collection("push_subscriptions").doc(uid).get();
    if (!doc.exists) return;
    const { subscription } = doc.data();
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    // Subscription expirée → supprimer
    if (err.statusCode === 410 || err.statusCode === 404) {
      await db.collection("push_subscriptions").doc(uid).delete();
    }
    console.error("Erreur push:", err.message);
  }
}

// ===== ENDPOINT POUR DÉCLENCHER MANUELLEMENT (debug) =====
app.post("/api/push/send", async (req, res) => {
  const { uid, title, body, annonceId, typeAlerte, count } = req.body;
  await envoyerNotificationPush(uid, { title, body, annonceId, typeAlerte, count });
  res.json({ message: "Notification envoyée" });
});

// ===== ALERTES LIÉES AU COMPTE =====

// Sauvegarder ou mettre à jour une alerte
app.post("/api/alertes", async (req, res) => {
  const { uid, typeAlerte, alerte } = req.body;
  if (!uid || !typeAlerte || !alerte) return res.status(400).json({ message: "Données manquantes" });
  try {
    await db.collection("alertes").doc(`${uid}_${typeAlerte}`).set({
      uid, typeAlerte, alerte,
      updatedAt: admin.firestore.Timestamp.now()
    });
    res.json({ message: "Alerte sauvegardée" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Charger les alertes d'un utilisateur
app.get("/api/alertes/:uid", async (req, res) => {
  try {
    const snap = await db.collection("alertes")
      .where("uid", "==", req.params.uid).get();
    const alertes = {};
    snap.docs.forEach(d => { alertes[d.data().typeAlerte] = d.data().alerte; });
    res.json(alertes);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Supprimer une alerte
app.delete("/api/alertes/:uid/:typeAlerte", async (req, res) => {
  try {
    await db.collection("alertes").doc(`${req.params.uid}_${req.params.typeAlerte}`).delete();
    res.json({ message: "Alerte supprimée" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ===================================================== */
/* ================= FIREBASE ADMIN ==================== */
/* ===================================================== */
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

/* ===================================================== */
/* ==================== AUTH ========================== */
/* ===================================================== */

/* --- INSCRIPTION --- */
app.post("/api/register", async (req, res) => {
    const { nom, email, password, inscontact } = req.body;
    if (!nom || !email || !password || !inscontact) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }
    if (typeof inscontact !== "string" || inscontact.length < 5) {
        return res.status(400).json({ message: "Le contact est invalide" });
    }
    try {
        const userRecord = await admin.auth().createUser({ email });

        await admin.auth().updateUser(userRecord.uid, {
            password: password
        });
        await db.collection("users").doc(userRecord.uid).set({
            uid: userRecord.uid,
            nom,
            email,
            inscontact,
            createdAt: admin.firestore.Timestamp.now()
        });
        res.status(201).json({ message: "Utilisateur créé", uid: userRecord.uid });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

/* --- CONNEXION --- */
app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const apiKey = process.env.FIREBASE_API_KEY;
        const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true })
        });
        const data = await response.json();
        if (data.error) {
            let message = "Erreur de connexion";
            if (data.error.message === "EMAIL_NOT_FOUND") message = "Email introuvable";
            else if (data.error.message === "INVALID_PASSWORD") message = "Mot de passe incorrect";
            else if (data.error.message === "INVALID_EMAIL") message = "Email invalide";
            return res.status(400).json({ message });
        }
        res.status(200).json({ message: "Connexion réussie", uid: data.localId });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================= GOOGLE AUTH ======================= */
/* ===================================================== */
app.post("/api/google-auth", async (req, res) => {
    const { idToken, inscontact } = req.body;
    if (!idToken) return res.status(400).json({ message: "Token manquant" });

    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        const { uid, name, email } = decoded;

        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            if (!inscontact) {
                return res.status(400).json({
                    message: "contact_required",
                    nom: name || "",
                    email: email
                });
            }
            await userRef.set({
                uid,
                nom: name || "",
                email,
                inscontact,
                provider: "google",
                createdAt: admin.firestore.Timestamp.now()
            });
            return res.status(201).json({ message: "Compte créé", uid, isNew: true });
        }

        return res.status(200).json({ message: "Connexion réussie", uid, isNew: false });

    } catch (err) {
        console.error("Erreur Google Auth:", err);
        if (err.code === "auth/id-token-expired") {
            return res.status(401).json({ message: "Session expirée, réessayez" });
        }
        if (err.code === "auth/argument-error") {
            return res.status(401).json({ message: "user_not_found" });
        }
        res.status(500).json({ message: "Erreur serveur" });
    }
});

/* --- mot de passe oublié --- */
app.post("/api/password-reset", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email requis" });

    try {
        await admin.auth().getUserByEmail(email);
        const link = await admin.auth().generatePasswordResetLink(email);

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        await transporter.sendMail({
            from: `"ChezMoi" <${process.env.GMAIL_USER}>`,
            to: email,
            subject: "Réinitialisation mot de passe",
            text: `Cliquez sur ce lien pour réinitialiser votre mot de passe :\n${link}`
        });

        res.json({ message: "Email envoyé" });

    } catch (error) {
        res.status(400).json({ message: "Email introuvable" });
    }
});

/* ===================================================== */
/* ================= PUBLIER ANNONCE =================== */
/* ===================================================== */
app.post("/api/annonces", upload.array("images", 15), async (req, res) => {
    try {

        const {
            uid, titre, type_annonce, description, prix, ville, quartier,
            douche, contact, repere, nbChambres, nbPieces, nbSalons, surface,
            etage, eau, electricite, parking, gardien, caution, avanceMax,
            nbDouches, charges, climatiseur, balcon, groupe_electrogene, forage, cuisine,
            type_cuisine, toilettes, meuble, disponibilite, disponibiliteDate, wifi, fraisVisite,
            type_sol, voirie, cloture, viabilisee, facade,
            titre_propriete, negociable, delai_vente
        } = req.body;

        if (!uid || !titre || !type_annonce || !description || !prix || !ville || !quartier || !contact) {
            return res.status(400).json({ message: "Champs obligatoires manquants" });
        }

        if (Number(prix) <= 0) {
            return res.status(400).json({ message: "Prix invalide" });
        }

        try { await admin.auth().getUser(uid); }
        catch { return res.status(400).json({ message: "Utilisateur introuvable" }); }

        // ======= EXPIRATION 30 JOURS =======
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
        const expireAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + THIRTY_DAYS));
        const now = new Date();

        // ======= UPLOAD IMAGES CLOUDINARY =======
        const imagesUrls = [];
        const imagesDeleteUrls = []; // On stocke les public_ids pour suppression

        if (req.files && req.files.length > 0) {
            console.log(`[Cloudinary] ${req.files.length} fichier(s) reçu(s)`);

            for (const file of req.files) {
                try {
                    if (!fs.existsSync(file.path)) {
                        console.error(`[Cloudinary] Fichier introuvable: ${file.path}`);
                        continue;
                    }

                    console.log(`[Cloudinary] Upload de ${file.originalname}`);

                    const result = await cloudinary.uploader.upload(file.path, {
                        folder: "chezmoi",
                        transformation: [
                            { width: 900, crop: "limit" },
                            { quality: "auto" }
                        ]
                    });

                    if (result.secure_url) {
                        imagesUrls.push(result.secure_url);
                        imagesDeleteUrls.push(result.public_id); // public_id pour supprimer plus tard
                        console.log(`[Cloudinary] ✅ URL: ${result.secure_url}`);
                    }

                } catch (err) {
                    console.error(`[Cloudinary] Erreur pour ${file.originalname}:`, err.message);
                } finally {
                    try {
                        if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
                    } catch (e) {}
                }
            }

            console.log(`[Cloudinary] Résultat: ${imagesUrls.length}/${req.files.length} images uploadées`);
        }

        
        // ======= CRÉER ANNONCE DIRECTEMENT PUBLIÉE =======
        const annonceRef = await db.collection("annonces").add({
            uid,
            titre,
            type_annonce,
            description,
            prix,
            ville,
            quartier,
            douche,
            contact,
            repere: repere || "",
            nbChambres: nbChambres || "",
            nbPieces: nbPieces || "",
            nbSalons: nbSalons || "",
            surface: surface || "",
            etage: etage || "",
            eau: eau || "",
            electricite: electricite || "",
            parking: parking || "",
            gardien: gardien || "",
            caution: caution || "",
            avanceMax: avanceMax || "",
            toilettes: toilettes || "",
            meuble: meuble || "",
            disponibilite: disponibilite || "",
            disponibiliteDate: disponibiliteDate || "",
            wifi: wifi || "",
            nbDouches: nbDouches || "",
            charges: charges || "",
            climatiseur: climatiseur || "",
            balcon: balcon || "",
            groupe_electrogene: groupe_electrogene || "",
            forage: forage || "",
            cuisine: cuisine || "",
            type_cuisine: type_cuisine || "",
            fraisVisite: fraisVisite || "",
            type_sol: type_sol || "",
            voirie: voirie || "",
            cloture: cloture || "",
            viabilisee: viabilisee || "",
            facade: facade || "",
            titre_propriete: titre_propriete || "",
            negociable: negociable || "",
            delai_vente: delai_vente || "",

            images: imagesUrls,
            imagesDeleteUrls: imagesDeleteUrls,
            statut: "published",           // publiée directement
            statut_numero: "verrouille",
            date_deblocage: "",
            createdAt: admin.firestore.Timestamp.fromDate(now),
            expireAt                        // 30 jours
        });

        // ===== NOTIFIER UNIQUEMENT LES USERS AVEC UNE ALERTE CORRESPONDANTE =====
        try {
            const typeAnnonce = titre?.toLowerCase().includes("vente") ? "vente" : "location";
            
            // Récupérer toutes les alertes du bon type
            const alertesSnap = await db.collection("alertes")
                .where("typeAlerte", "==", typeAnnonce).get();

            for (const alerteDoc of alertesSnap.docs) {
                const { uid: alerteUid, alerte } = alerteDoc.data();
                if (alerteUid === uid) continue; // pas le propriétaire

                // Vérifier si l'annonce correspond aux critères de l'alerte
                const correspondre = (() => {
                    if (alerte.ville && ville?.toLowerCase() !== alerte.ville.toLowerCase()) return false;
                    if (alerte.types?.length && !alerte.types.some(t => type_annonce?.toLowerCase() === t.toLowerCase())) return false;
                    if (alerte.quartiers?.length) {
                        const q = (quartier || "").toLowerCase();
                        if (!alerte.quartiers.some(aq => q.includes(aq.toLowerCase()))) return false;
                    }
                    const prixNum = Number(prix);
                    if (alerte.budgetMin && prixNum < alerte.budgetMin) return false;
                    if (alerte.budgetMax && prixNum > alerte.budgetMax) return false;
                    if (alerte.meuble && meuble && alerte.meuble !== meuble) return false;
                    if (alerte.wifi && wifi && alerte.wifi !== wifi) return false;
                    if (alerte.climatiseur && climatiseur && alerte.climatiseur !== climatiseur) return false;
                    return true;
                })();

                if (!correspondre) continue;

                // Envoyer la notification
                await envoyerNotificationPush(alerteUid, {
                    title: `ChezMoi 🔔 — Nouveau bien ${typeAnnonce}`,
                    body: `${type_annonce} à ${ville} — ${Number(prix).toLocaleString("fr-FR")} XAF`,
                    annonceId: annonceRef.id,
                    typeAlerte: typeAnnonce,
                    count: 1
                });
            }
        } catch (e) { /* silencieux */ }

        res.status(201).json({
            message: "Annonce publiée avec succès",
            id: annonceRef.id
        });

    } catch (err) {
        console.error("Erreur backend annonces :", err);
        res.status(500).json({ message: err.message });
    }
});

/* ===================================================== */
/* ================= OBTENIR ANNONCES ================= */
/* ===================================================== */
app.get("/api/annonces", async (req, res) => {
    try {
        const now = admin.firestore.Timestamp.now();

        // Supprime annonces expirées
        const expiredSnapshot = await db.collection("annonces").where("expireAt", "<=", now).get();
        for (const doc of expiredSnapshot.docs) {
            const data = doc.data();

            if (data.imagesDeleteUrls && data.imagesDeleteUrls.length > 0) {
                for (const publicId of data.imagesDeleteUrls) {
                    try {
                        await cloudinary.uploader.destroy(publicId);
                    } catch(err) {
                        console.error("Erreur suppression image Cloudinary:", err);
                    }
                }
            }

            // Supprimer favoris liés
            const favSnapshot = await db.collection("favorites")
                .where("annonceId", "==", doc.id)
                .get();
            for (const favDoc of favSnapshot.docs) {
                await favDoc.ref.delete();
            }

            await doc.ref.delete();
        }

        // Récupère annonces valides
        const snapshot = await db.collection("annonces")
            .where("expireAt", ">", now)
            .where("statut", "==", "published")
            .get();
        const annonces = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        res.json(annonces);

    } catch(err) {
        console.error("Erreur backend get annonces :", err);
        res.status(500).json({ message: err.message });
    }
});

// ================= GET TOUS LES COMPTES =================
app.get("/api/user/accounts", async (req, res) => {
    try {
        const snapshot = await db.collection("users").get();
        const users = snapshot.docs.map(doc => ({
            uid: doc.id,
            nom: doc.data().nom,
            email: doc.data().email,
            avatar: doc.data().avatar || "image/avatar.png"
        }));
        res.json(users);
    } catch (err) {
        console.error("Erreur récupération comptes :", err);
        res.status(500).json({ message: err.message });
    }
});

/* ===================================================== */
/* ================== OBTENIR L'UTILISATEUR ============ */
/* ===================================================== */
app.get("/api/user/:uid", async (req, res) => {
    try {
        const uid = req.params.uid;
        const userDoc = await db.collection("users").doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: "Utilisateur introuvable" });
        }

        res.json(userDoc.data());

    } catch (error) {
        console.error("Erreur récupération utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ========= GET ANNONCES PAR UTILISATEUR ============== */
/* ===================================================== */
app.get("/api/annonces/user/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const now = admin.firestore.Timestamp.now();

        const snapshot = await db.collection("annonces")
            .where("uid", "==", uid)
            .where("expireAt", ">", now)
            .where("statut", "==", "published")
            .get();

        const annonces = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json(annonces);

    } catch (error) {
        console.error("Erreur récupération annonces utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ================= FAVORIS ================= */

// Ajouter une annonce aux favoris
app.post("/api/favorites", async (req, res) => {
    try {
        const { uid, annonceId } = req.body;
        if (!uid || !annonceId) return res.status(400).json({ message: "UID et annonceId requis" });

        const favDoc = await db.collection("favorites")
            .where("uid", "==", uid)
            .where("annonceId", "==", annonceId)
            .get();

        if (!favDoc.empty) return res.status(400).json({ message: "Annonce déjà en favoris" });

        const docRef = await db.collection("favorites").add({
            uid,
            annonceId,
            createdAt: admin.firestore.Timestamp.now()
        });

        res.status(201).json({ message: "Ajouté aux favoris", id: docRef.id });

    } catch (error) {
        console.error("Erreur ajout favoris :", error);
        res.status(500).json({ message: error.message });
    }
});

// Supprimer une annonce des favoris
app.delete("/api/favorites", async (req, res) => {
    try {
        const { uid, annonceId } = req.body;
        if (!uid || !annonceId) return res.status(400).json({ message: "UID et annonceId requis" });

        const favSnapshot = await db.collection("favorites")
            .where("uid", "==", uid)
            .where("annonceId", "==", annonceId)
            .get();

        if (favSnapshot.empty) return res.status(404).json({ message: "Favori introuvable" });

        for (const doc of favSnapshot.docs) {
            await doc.ref.delete();
        }

        res.json({ message: "Favori supprimé" });

    } catch (error) {
        console.error("Erreur suppression favoris :", error);
        res.status(500).json({ message: error.message });
    }
});

// Obtenir toutes les annonces favorites d'un utilisateur
app.get("/api/favorites/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const snapshot = await db.collection("favorites")
            .where("uid", "==", uid)
            .get();

        const favoriteIds = snapshot.docs.map(doc => doc.data().annonceId);
        res.json(favoriteIds);

    } catch (error) {
        console.error("Erreur récupération favoris :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ============ OBTENIR UNE ANNONCE PAR ID =========== */
/* ===================================================== */
app.get("/api/annonces/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const annonceDoc = await db.collection("annonces").doc(id).get();

        if (!annonceDoc.exists) {
            return res.status(404).json({ message: "Annonce introuvable" });
        }

        const annonce = annonceDoc.data();
        const now = admin.firestore.Timestamp.now();

        if (annonce.expireAt && annonce.expireAt <= now) {
            return res.status(410).json({ message: "Annonce expirée" });
        }

        if (annonce.statut !== "published") {
            return res.status(403).json({ message: "Annonce non disponible" });
        }

        res.json({ id: annonceDoc.id, ...annonce });
    } catch (error) {
        console.error("Erreur récupération annonce :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================= SUPPRIMER ANNONCE ================= */
/* ===================================================== */
app.delete("/api/annonces/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { uid } = req.body;

        const annonceRef = db.collection("annonces").doc(id);
        const annonceDoc = await annonceRef.get();

        if (!annonceDoc.exists) {
            return res.status(404).json({ message: "Annonce introuvable" });
        }

        const annonce = annonceDoc.data();

        if (annonce.uid !== uid) {
            return res.status(403).json({ message: "Non autorisé" });
        }

        if (annonce.imagesDeleteUrls && annonce.imagesDeleteUrls.length > 0) {
            for (const publicId of annonce.imagesDeleteUrls) {
                try {
                    await cloudinary.uploader.destroy(publicId);
                    console.log(`[Cloudinary] Image supprimée: ${publicId}`);
                } catch (err) {
                    console.error("Erreur suppression image Cloudinary:", err);
                }
            }
        }

        const favSnapshot = await db.collection("favorites")
            .where("annonceId", "==", id)
            .get();

        for (const doc of favSnapshot.docs) {
            await doc.ref.delete();
        }

        await annonceRef.delete();

        res.json({ message: "Annonce supprimée avec succès" });

    } catch (error) {
        console.error("Erreur suppression annonce :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================= MODIFIER UTILISATEUR ============== */
/* ===================================================== */
app.put("/api/user/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const { nom, email, inscontact } = req.body;

        if (!nom || !email || !inscontact) {
            return res.status(400).json({ message: "Tous les champs sont obligatoires" });
        }

        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: "Utilisateur introuvable" });
        }

        await userRef.update({
            nom,
            email,
            inscontact,
            updatedAt: admin.firestore.Timestamp.now()
        });

        await admin.auth().updateUser(uid, { email });

        res.json({ message: "Profil mis à jour avec succès" });

    } catch (error) {
        console.error("Erreur modification utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================== SIGNALER UN PROBLEME ============= */
/* ===================================================== */
app.post("/api/report", async (req, res) => {
    const { nom, email, sujet, message, annonce } = req.body;

    if (!nom || !email || !sujet || !message || !annonce) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        const mailOptions = {
            from: `"${nom}" <${email}>`,
            to: process.env.GMAIL_USER,
            subject: `Signalement: ${sujet}`,
            text:
            `Nom: ${nom}
            Email: ${email}

            Message:
            ${message}

            Annonce concernée:
            - ID: ${annonce.id}
            - Titre: ${annonce.titre}
            - Type: ${annonce.type}
            - Ville: ${annonce.ville}
            - Quartier: ${annonce.quartier}
            - Prix: ${annonce.prix} FCFA`
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: "Signalement envoyé avec succès !" });

    } catch (error) {
        console.error("Erreur envoi mail report :", error);
        res.status(500).json({ message: "Impossible d'envoyer le signalement" });
    }
});

/* ===================================================== */
/* ================== PROPOSER UNE IDEE ================ */
/* ===================================================== */
app.post("/api/idea", async (req, res) => {

    const { nom, email, sujet, message } = req.body;

    if (!nom || !email || !sujet || !message) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        const mailOptions = {
            from: `"${nom}" <${email}>`,
            to: process.env.GMAIL_USER,
            subject: `💡 Nouvelle idée ChezMoi : ${sujet}`,
            text:
            `Nouvelle idée proposée depuis ChezMoi

            Nom: ${nom}
            Email: ${email}

            Titre de l'idée:
            ${sujet}

            Description:
            ${message}`
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: "Idée envoyée avec succès !" });

    } catch (error) {
        console.error("Erreur envoi mail idée :", error);
        res.status(500).json({ message: "Impossible d'envoyer l'idée" });
    }
});

/* ===================================================== */
/* ============ CONTACT REQUESTS ======================= */
/* ===================================================== */

// GET — Vérifier statut déblocage pour une annonce
app.get("/api/contact-requests/status", async (req, res) => {
  const { annonceId, userId } = req.query;
  if (!annonceId) return res.status(400).json({ message: "annonceId requis" });

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = admin.firestore.Timestamp.fromDate(today);

    const snap = await db.collection("contact_requests")
      .where("annonceId", "==", annonceId)
      .where("createdAt", ">=", todayTs)
      .get();

    const used = snap.size;

    let dejaUtilise = false;
    if (userId) {
      const userSnap = await db.collection("contact_requests")
        .where("annonceId", "==", annonceId)
        .where("userId", "==", userId)
        .get();
      dejaUtilise = !userSnap.empty;
    }

    res.json({ used, dejaUtilise });
  } catch (err) {
    console.error("Erreur contact-requests/status:", err); // ← AJOUTE ÇA
    res.status(500).json({ message: err.message });        // ← ET ÇA
  }
});

/* ========================= */
// POST — Créer une demande de contact
/* ======================== */
app.post("/api/contact-requests", async (req, res) => {
  const { annonceId, ownerId, userId, prenom, whatsapp, urgence, budget } = req.body;

  if (!annonceId || !userId || !prenom || !whatsapp || !urgence || !budget) {
    return res.status(400).json({ message: "Champs manquants" });
  }

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = admin.firestore.Timestamp.fromDate(today);

    // Vérifier quota journalier
    const snapDay = await db.collection("contact_requests")
      .where("annonceId", "==", annonceId)
      .where("createdAt", ">=", todayTs)
      .get();

    if (snapDay.size >= 5) {
      return res.status(429).json({ message: "Quota de contacts atteint pour aujourd'hui." });
    }

    // Vérifier si ce user a déjà demandé
    const snapUser = await db.collection("contact_requests")
      .where("annonceId", "==", annonceId)
      .where("userId", "==", userId)
      .get();

    if (!snapUser.empty) {
      return res.status(409).json({ message: "Vous avez déjà utilisé votre accès pour cette annonce." });
    }

    // Enregistrer
    await db.collection("contact_requests").add({
      annonceId,
      ownerId: ownerId || "",
      userId,
      prenom,
      whatsapp,
      urgence,
      budget,
      createdAt: admin.firestore.Timestamp.now(),
      status: "nouvelle"
    });

    // ===== NOTIFICATIONS WHATSAPP =====
    // On lance en arrière-plan — ne bloque pas la réponse
    (async () => {
      try {
        // Récupérer les données de l'annonce
        const annonceDoc = await db.collection("annonces").doc(annonceId).get();
        if (!annonceDoc.exists) {
          console.warn("[WhatsApp] Annonce introuvable:", annonceId);
          return;
        }
        const annonce = annonceDoc.data();

        // Récupérer les données du propriétaire
        const ownerDoc = await db.collection("users").doc(ownerId).get();
        const owner = ownerDoc.exists ? ownerDoc.data() : {};

        // ===== GÉNÉRER TOKEN + COMPTEUR =====
        const token    = await creerActionRequest(db, {
          annonceId,
          ownerUid:     ownerId,
          requesterUid: userId
        });

        const compteur = await getCompteurJournalier(db, annonceId);

        const contexte = {
          titre:           annonce.titre || "Annonce",
          prix:            annonce.prix  || "0",
          ville:           annonce.ville || "",
          quartier:        annonce.quartier || "",
          annonceId,
          nomProprio:      owner.nom        || "Propriétaire",
          numeroProprio:   owner.inscontact || annonce.contact || "",
          prenomDemandeur: prenom,
          numeroDemandeur: whatsapp,
          urgence,
          budget,
          token,
          compteur
        };

        // Formater les numéros (UltraMsg attend le format international sans +)
        const numProprio    = String(contexte.numeroProprio).replace(/\D/g, "");
        const numDemandeur  = String(whatsapp).replace(/\D/g, "");
        const numAdmin      = String(process.env.ULTRAMSG_ADMIN_PHONE || "").replace(/\D/g, "");

        console.log("[WhatsApp] Envoi des 3 notifications...");

        // 1. Message au propriétaire AVEC liens d'action
        if (numProprio) {
          await sendWhatsApp(numProprio, msgProprietaire(contexte));
        } else {
          console.warn("[WhatsApp] Numéro proprio manquant — message proprio ignoré");
        }

        // 2. Message à l'admin
        if (numAdmin) {
          await sendWhatsApp(numAdmin, msgAdmin(contexte));
        } else {
          console.warn("[WhatsApp] ULTRAMSG_ADMIN_PHONE non défini — message admin ignoré");
        }

        // 3. Message au demandeur
        if (numDemandeur) {
          await sendWhatsApp(numDemandeur, msgDemandeur(contexte));
        } else {
          console.warn("[WhatsApp] Numéro demandeur manquant — message demandeur ignoré");
        }

        console.log("[WhatsApp] ✅ 3 notifications traitées");

      } catch (err) {
        // Ne jamais faire crasher le backend à cause de WhatsApp
        console.error("[WhatsApp] ❌ Erreur bloc notifications:", err.message);
      }
    })();
    // ===== FIN NOTIFICATIONS WHATSAPP =====

    res.status(201).json({ message: "Demande enregistrée" });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ===================================================== */
/* ============ WHATSAPP ACTION HELPERS ================ */
/* ===================================================== */

async function validateActionToken(token) {
  if (!token || typeof token !== "string" || token.length < 10) {
    return { valid: false, reason: "Token manquant ou invalide." };
  }

  const ref = db.collection("action_requests").doc(token);
  const snap = await ref.get();

  if (!snap.exists) {
    return { valid: false, reason: "Ce lien n'existe pas." };
  }

  const data = snap.data();

  const now = admin.firestore.Timestamp.now();
  if (data.expireAt && data.expireAt.toMillis() < now.toMillis()) {
    return { valid: false, reason: "Ce lien a expiré (valide 24h)." };
  }

  if (data.status !== "pending") {
    const labels = {
      accepted:    "✅ Vous avez déjà accepté ce locataire.",
      closed_loue: "🔒 Vous avez déjà marqué ce bien comme loué.",
      refused:     "❌ Vous avez déjà refusé cette demande."
    };
    return {
      valid: false,
      reason: labels[data.status] || "Ce lien a déjà été utilisé."
    };
  }

  return { valid: true, ref, data };
}

async function markActionStatus(ref, status) {
  await ref.update({
    status,
    processedAt: admin.firestore.Timestamp.now()
  });
}

function htmlRetour(emoji, titre, message, couleur) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChezMoi — Action enregistrée</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      padding: 40px 30px;
      max-width: 380px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 30px rgba(0,0,0,0.10);
    }
    .emoji { font-size: 56px; margin-bottom: 18px; }
    .titre { font-size: 20px; font-weight: 700; color: ${couleur}; margin-bottom: 12px; }
    .message { font-size: 15px; color: #555; line-height: 1.6; }
    .brand { margin-top: 32px; font-size: 13px; color: #bbb; font-weight: 500; }
    .dot { color: #fd802e; font-weight: 800; }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">${emoji}</div>
    <div class="titre">${titre}</div>
    <div class="message">${message}</div>
    <div class="brand">Chez<span class="dot">Moi</span> &mdash; Immobilier au Congo</div>
  </div>
</body>
</html>`;
}

async function getContexteAction(data) {
  // data = contenu du doc action_requests
  const numAdmin = String(process.env.ULTRAMSG_ADMIN_PHONE || "").replace(/\D/g, "");

  // Récupérer annonce
  const annonceDoc = await db.collection("annonces").doc(data.annonceId).get();
  const annonce = annonceDoc.exists ? annonceDoc.data() : {};

  // Récupérer proprio
  const ownerDoc = await db.collection("users").doc(data.ownerUid).get();
  const owner = ownerDoc.exists ? ownerDoc.data() : {};

  // Récupérer demandeur depuis contact_requests
  const reqSnap = await db.collection("contact_requests")
    .where("annonceId", "==", data.annonceId)
    .where("userId", "==", data.requesterUid)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  const req = reqSnap.empty ? {} : reqSnap.docs[0].data();

  return {
    annonceId:       data.annonceId,
    nomProprio:      owner.nom        || "Propriétaire",
    numeroProprio:   String(owner.inscontact || annonce.contact || "").replace(/\D/g, ""),
    prenomDemandeur: req.prenom       || "le locataire",
    numeroDemandeur: String(req.whatsapp || "").replace(/\D/g, ""),
    quartier:        annonce.quartier || "",
    prix:            annonce.prix     || "0",
    numAdmin
  };
}

/* ===================================================== */
/* ============ WHATSAPP ACTION ROUTES ================= */
/* ===================================================== */

app.get("/api/whatsapp/action/accept", async (req, res) => {
  const { token } = req.query;
  try {
    const result = await validateActionToken(token);
    if (!result.valid) {
      return res.status(410).send(htmlRetour("⚠️", "Lien non valide", result.reason, "#e65100"));
    }
    await markActionStatus(result.ref, "accepted");

    res.send(htmlRetour(
      "✅", "Locataire accepté !",
      "Votre choix a bien été enregistré par ChezMoi.<br>Le locataire sera notifié.",
      "#2e7d32"
    ));

    // Notifications en arrière-plan
    (async () => {
      try {
        const ctx = await getContexteAction(result.data);
        const { nomProprio, numeroProprio, prenomDemandeur, numeroDemandeur, numAdmin, annonceId, quartier, prix } = ctx;

        if (numeroDemandeur) await sendWhatsApp(numeroDemandeur, msgAfterAccept({ prenomDemandeur, numeroDemandeur, nomProprio, numeroProprio, quartier, prix }));
        if (numeroProprio)   await sendWhatsApp(numeroProprio,   msgAfterAcceptProprio({ nomProprio, prenomDemandeur, numeroDemandeur, quartier, prix }));
        if (numAdmin)        await sendWhatsApp(numAdmin,        msgAfterAcceptAdmin({ annonceId, nomProprio, prenomDemandeur }));
      } catch (err) {
        console.error("[Action/accept] Notif erreur:", err.message);
      }
    })();

  } catch (err) {
    console.error("[Action/accept] Erreur:", err.message);
    res.status(500).send(htmlRetour("❌", "Erreur serveur", "Réessayez plus tard.", "#c62828"));
  }
});

app.get("/api/whatsapp/action/loue", async (req, res) => {
  const { token } = req.query;
  try {
    const result = await validateActionToken(token);
    if (!result.valid) {
      return res.status(410).send(htmlRetour("⚠️", "Lien non valide", result.reason, "#e65100"));
    }
    await markActionStatus(result.ref, "closed_loue");

    // Désactiver l'annonce en base
    try {
      await db.collection("annonces").doc(result.data.annonceId).update({
        statut: "loue",
        active: false,
        louéAt: admin.firestore.Timestamp.now()
      });
    } catch (e) {
      console.error("[Action/loue] Erreur désactivation annonce:", e.message);
    }

    res.send(htmlRetour(
      "🔒", "Bien marqué comme loué",
      "Votre annonce a été marquée comme déjà louée.<br>Merci pour la mise à jour.",
      "#5d4037"
    ));

    // Notifications en arrière-plan
    (async () => {
      try {
        const ctx = await getContexteAction(result.data);
        const { nomProprio, prenomDemandeur, numeroDemandeur, numAdmin, annonceId } = ctx;

        if (numeroDemandeur) await sendWhatsApp(numeroDemandeur, msgAfterLoue({ prenomDemandeur }));
        if (numAdmin)        await sendWhatsApp(numAdmin,        msgAfterLoueAdmin({ annonceId, nomProprio }));
      } catch (err) {
        console.error("[Action/loue] Notif erreur:", err.message);
      }
    })();

  } catch (err) {
    console.error("[Action/loue] Erreur:", err.message);
    res.status(500).send(htmlRetour("❌", "Erreur serveur", "Réessayez plus tard.", "#c62828"));
  }
});

app.get("/api/whatsapp/action/refuse", async (req, res) => {
  const { token } = req.query;
  try {
    const result = await validateActionToken(token);
    if (!result.valid) {
      return res.status(410).send(htmlRetour("⚠️", "Lien non valide", result.reason, "#e65100"));
    }
    await markActionStatus(result.ref, "refused");

    res.send(htmlRetour(
      "❌", "Demande refusée",
      "Votre refus a bien été enregistré.",
      "#c62828"
    ));

    // Notifications en arrière-plan
    (async () => {
      try {
        const ctx = await getContexteAction(result.data);
        const { nomProprio, prenomDemandeur, numeroDemandeur, numAdmin, annonceId } = ctx;

        if (numeroDemandeur) await sendWhatsApp(numeroDemandeur, msgAfterRefuse({ prenomDemandeur }));
        if (numAdmin)        await sendWhatsApp(numAdmin,        msgAfterRefuseAdmin({ annonceId, nomProprio, prenomDemandeur }));
      } catch (err) {
        console.error("[Action/refuse] Notif erreur:", err.message);
      }
    })();

  } catch (err) {
    console.error("[Action/refuse] Erreur:", err.message);
    res.status(500).send(htmlRetour("❌", "Erreur serveur", "Réessayez plus tard.", "#c62828"));
  }
});

/* ==================================== */
/* ====  MODIFIER L'ANNONCE ========== */
/* ==================================== */

app.put("/api/annonces/:id", async (req, res) => {
  const { uid, prix, quartier, repere, contact, description, fraisVisite, caution, avanceMax } = req.body;
  try {
    const ref = db.collection("annonces").doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ message: "Introuvable" });
    if (doc.data().uid !== uid) return res.status(403).json({ message: "Non autorisé" });
    await ref.update({ prix, quartier, repere, contact, description, fraisVisite, caution, avanceMax,
      updatedAt: admin.firestore.Timestamp.now() });
    res.json({ message: "Annonce mise à jour" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ===================================================== */
/* ================== LANCEMENT SERVEUR =============== */
/* ===================================================== */
app.listen(PORT, () => {
    console.log(`Backend ChezMoi lancé sur ${PORT}`);
});