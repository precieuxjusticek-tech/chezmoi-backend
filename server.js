/* ======== process.env ======== */
require("dotenv").config();
/* ===================================================== */
/* ================= IMPORTS =========================== */
/* ===================================================== */
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // pour Imgbb
const crypto = require("crypto");
const nodemailer = require("nodemailer"); // pour email
const webhookSecret = process.env.YABETOO_WEBHOOK_SECRET; // pour le webhook
const YABETOOPAY_API_KEY = process.env.YABETOOPAY_API_KEY; // la clé api
const YABETOOPAY_SECRET_KEY = process.env.YABETOOPAY_SECRET_KEY; // la clé api secrete
const YABETOOPAY_MERCHANT_ID = process.env.YABETOOPAY_MERCHANT_ID; // la clé merchant


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
    // --- Validation basique avant d'envoyer à Firebase ---
    if (!nom || !email || !password || !inscontact) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }
    if (typeof inscontact !== "string" || inscontact.length < 5) {
        return res.status(400).json({ message: "Le contact est invalide" });
    }
    try {
        const userRecord = await admin.auth().createUser({ email, password });
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
        if (data.error) return res.status(400).json({ message: data.error.message });
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
        // Vérifier le token Google avec Firebase Admin
        const decoded = await admin.auth().verifyIdToken(idToken);
        const { uid, name, email } = decoded;

        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            // Nouvel utilisateur — vérifier si le contact est fourni
            if (!inscontact) {
                return res.status(400).json({
                    message: "contact_required",
                    nom: name || "",
                    email: email
                });
            }
            // Créer l'utilisateur dans Firestore
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

        // Utilisateur existant → connexion directe
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

/* --- mot de passe ounlié -- */
app.post("/api/password-reset", async (req, res) => {
    const { email } = req.body;

    if (!email) return res.status(400).json({ message: "Email requis" });

    try {
        // Vérifie si utilisateur existe
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
            douche, contact, packSelectionne,
            // nouveaux champs
            repere, nbChambres, nbPieces, nbSalons, surface, etage,
            eau, electricite, parking, gardien, caution, avanceMax,
            nbDouches, charges, climatiseur, balcon, 
            groupe_electrogene, forage, cuisine, type_cuisine,
            toilettes, meuble, disponibilite, disponibiliteDate, wifi 
        } = req.body;

        if (!uid || !titre || !type_annonce || !description || !prix || !ville || !quartier || !contact) {
            return res.status(400).json({ message: "Champs obligatoires manquants" });
        }

        if (Number(prix) <= 0) {
            return res.status(400).json({ message: "Prix invalide" });
        }

        try { await admin.auth().getUser(uid); } 
        catch { return res.status(400).json({ message: "Utilisateur introuvable" }); }

        // ======= CALCUL PRIX FINAL =======
        const prixBaseAnnonce = { location: 1000, vente: 3000 };
        const packPrix = Number(packSelectionne || 0) * 200;
        let totalPrix = (prixBaseAnnonce[type_annonce.toLowerCase()] || 0) + packPrix;
        totalPrix = totalPrix / (1 - 0.06);
        totalPrix = Math.ceil(totalPrix / 5) * 5;
        totalPrix = Math.round(totalPrix);

        // Crée annonce avec statut "pending_payment"
        const now = new Date();
        const EXPIRATION_TIME = 2*60*1000 // 2 min
        const expireAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + EXPIRATION_TIME));
        const annonceRef = await db.collection("annonces").add({
            uid,
            titre,
            type_annonce,
            description,
            prix,
            prixAPayer: totalPrix,
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
            images: [],            // images uploadées après paiement
            imagesDeleteUrls: [],  // delete URLs Imgbb
            packSelectionne: Number(packSelectionne || 0),
            statut: "pending_payment",
            createdAt: admin.firestore.Timestamp.fromDate(now),
            expireAt
        });

        if (req.files && req.files.length > 0) {
            const imagesTemp = req.files.map(file => fs.readFileSync(file.path, { encoding: "base64" }));
            await annonceRef.update({ imagesTemp });
            // tu peux supprimer les fichiers temporaires si tu veux
            req.files.forEach(file => fs.unlinkSync(file.path));
        }

        res.status(201).json({ 
            message: "Annonce créée, paiement requis", 
            id: annonceRef.id,
            prixAPayer: totalPrix
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
            if (data.imagesDeleteUrls) {
                for (const deleteUrl of data.imagesDeleteUrls) {
                    try { await fetch(deleteUrl, { method: "GET" }); }
                    catch(err){ console.error("Erreur suppression image Imgbb :", err); }
                }
            }

            //  Supprimer favoris liés
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
            avatar: doc.data().avatar || "image/avatar.png" // si tu veux gérer les avatars
        }));
        res.json(users);
    } catch (err) {
        console.error("Erreur récupération comptes :", err);
        res.status(500).json({ message: err.message });
    }
});

/* ===================================================== */
/* ================== OBTENIR L'UTILISATEUR ========================= */
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
            .where("uid", "==", uid)       // filtrer par utilisateur
            .where("expireAt", ">", now)   // ne prendre que les annonces valides
            .where("statut", "==", "published") // <-- seulement les annonces payées
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

        // Vérifie si déjà favori
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

        // Vérifie si l'annonce est expirée
        if (annonce.expireAt && annonce.expireAt <= now) {
            return res.status(410).json({ message: "Annonce expirée" });
        }

        // Vérifie si l'annonce est publiée
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
        const { uid } = req.body; // on vérifie le propriétaire

        const annonceRef = db.collection("annonces").doc(id);
        const annonceDoc = await annonceRef.get();

        if (!annonceDoc.exists) {
            return res.status(404).json({ message: "Annonce introuvable" });
        }

        const annonce = annonceDoc.data();

        // Vérifie que c’est le propriétaire
        if (annonce.uid !== uid) {
            return res.status(403).json({ message: "Non autorisé" });
        }

        // Supprimer images Imgbb
        if (annonce.imagesDeleteUrls && annonce.imagesDeleteUrls.length > 0) {
            for (const deleteUrl of annonce.imagesDeleteUrls) {
                try {
                    await fetch(deleteUrl, { method: "GET" });
                } catch (err) {
                    console.error("Erreur suppression image Imgbb :", err);
                }
            }
        }

        // Supprimer aussi les favoris liés à cette annonce
        const favSnapshot = await db.collection("favorites")
            .where("annonceId", "==", id)
            .get();

        for (const doc of favSnapshot.docs) {
            await doc.ref.delete();
        }

        // Supprimer annonce Firestore
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

        // Vérifie si utilisateur existe
        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: "Utilisateur introuvable" });
        }

        // Mettre à jour Firestore
        await userRef.update({
            nom,
            email,
            inscontact,
            updatedAt: admin.firestore.Timestamp.now()
        });

        // Mettre à jour aussi email Firebase Auth
        await admin.auth().updateUser(uid, {
            email
        });

        res.json({ message: "Profil mis à jour avec succès" });

    } catch (error) {
        console.error("Erreur modification utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================== SIGNALER UN PROBLEME ================== */
/* ===================================================== */

app.post("/api/report", async (req, res) => {
    const { nom, email, sujet, message, annonce } = req.body;

    // Validation simple
    if (!nom || !email || !sujet || !message || !annonce) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }

    try {
        // Création du transporteur avec nodemailer et Gmail
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,     // ton email dans .env
                pass: process.env.GMAIL_PASS      // ton mot de passe d'application
            }
        });

        // Contenu du mail
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

        // Envoi du mail
        await transporter.sendMail(mailOptions);

        res.status(200).json({ message: "Signalement envoyé avec succès !" });
    } catch (error) {
        console.error("Erreur envoi mail report :", error);
        res.status(500).json({ message: "Impossible d'envoyer le signalement" });
    }
});

/* ===================================================== */
/* ================== PROPOSER UNE IDEE ================= */
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

// =====================================================
// ============= CREER SESSION PAIEMENT ANNONCE ========
// =====================================================
app.post("/api/create-annonce-payment", async (req, res) => {
    try {
        const { uid, annonceId, titre, packSelectionne } = req.body;

        if (!uid || !titre || !annonceId) {
            return res.status(400).json({ message: "Informations manquantes" });
        }

        const prixBaseAnnonce = { location: 1000, vente: 3000 };
        if (!prixBaseAnnonce[titre.toLowerCase()]) {
            return res.status(400).json({ message: "Type d'annonce invalide" });
        }

        const packPrix = Number(packSelectionne || 0) * 200;
        const prixReel = prixBaseAnnonce[titre.toLowerCase()] + packPrix;
        const frais = Math.ceil(prixReel * 0.06);
        const totalPrix = prixReel + frais;

        const body = {
            accountId: YABETOOPAY_MERCHANT_ID,
            total: totalPrix,
            currency: "xaf",
            successUrl: "https://chezmoi-app.netlify.app/#home",
            cancelUrl: "https://chezmoi-app.netlify.app/#ajouter",
            metadata: { type: "publication_annonce", uid, annonceId },
            items: [
                { productId: "publication_annonce", productName: "Prix réel", quantity: 1, price: prixReel },
                { productId: "frais_yabetoopay", productName: "Frais Yabeto", quantity: 1, price: frais }
            ],
            expiresAt: Math.floor(Date.now() / 1000) + 30 * 60
        };

        const response = await fetch("https://buy.api.yabetoopay.com/v1/sessions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${YABETOOPAY_SECRET_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();
        if (!response.ok) return res.status(400).json({ message: "Erreur Yabeto", details: data });

        // ← ENREGISTRER LA REFERENCE DANS L'ANNONCE
        await db.collection("annonces").doc(annonceId).update({
            paymentReference: data.id // <- sessionId Yabeto
        });

        res.json({
            sessionId: data.id,
            redirectUrl: data.url,
            montant: totalPrix
        });

    } catch (error) {
        console.error("Erreur création paiement :", error);
        res.status(500).json({ message: "Erreur serveur paiement", error: error.message });
    }
});

// ==================== ROLLBACK ANNOUNCE ====================
async function rollbackAnnonce(annonceRef, annonceData) {
    try {
        // Vérifie si l'annonce a déjà été payée
        if (annonceData.paiementEffectue) {
            console.log("⚠ Rollback ignoré : annonce déjà payée :", annonceRef.id);
            return;
        }

        // Supprimer images Imgbb
        if (annonceData.imagesDeleteUrls?.length) {
            for (const deleteUrl of annonceData.imagesDeleteUrls) {
                try {
                    console.log("Suppression image Imgbb :", deleteUrl);
                    await fetch(deleteUrl, { method: "DELETE" });
                } catch (err) {
                    console.error("Erreur suppression image Imgbb :", err);
                }
            }
        }

        // Supprimer favoris liés à cette annonce
        const favSnapshot = await db.collection("favorites")
            .where("annonceId", "==", annonceRef.id)
            .get();

        for (const doc of favSnapshot.docs) {
            console.log("Suppression favori :", doc.id);
            await doc.ref.delete();
        }

        // Supprimer annonce Firestore
        await annonceRef.delete();
        console.log("Annonce supprimée (rollback) :", annonceRef.id);

    } catch (err) {
        console.error("Erreur lors du rollback de l'annonce :", err);
    }
}

// =========================================================
// ==================== WEBHOOK YABETOO ====================
// =========================================================
app.post("/webhook/yabetoo", express.json({ type: "application/json" }), async (req, res) => {
    
    try {

        const signature = req.headers['x-yabetoo-webhook-signature'];
        const timestamp = req.headers['x-yabetoo-webhook-timestamp'];

        // Vérifier la signature HMAC
        const payload = timestamp + "." + JSON.stringify(req.body);
        const expectedSignature = crypto.createHmac("sha256", webhookSecret)
            .update(payload)
            .digest("hex");

        if (signature !== expectedSignature) {
            console.warn("⚠ Signature invalide !");
            return res.status(401).send("Signature invalide");
        }

        const event = req.body;
        console.log("event.type:", event.type);

        const eventType = event?.data?.intent?.metadata?.type;
        const annonceId = event?.data?.intent?.metadata?.annonceId;

        if (!annonceId) {
            console.warn("⚠ Pas d'annonceId dans l'événement !");
            return res.status(400).send("annonceId manquant");
        }
        console.log("annonceId extrait:", annonceId);
        console.log("eventType extrait:", eventType);

        const annonceRef = db.collection("annonces").doc(annonceId);
        const annonceDoc = await annonceRef.get();

        if (!annonceDoc.exists) {
            console.warn("Annonce non trouvée :", annonceId);
            return res.status(404).send("Annonce non trouvée");
        }

        const annonceData = annonceDoc.data();

        // ===== DEBLOCAGE CONTACT =====
        if (eventType === "deblocage_contact") {
            if (event.type === "intent.succeeded") {
                const maintenant = new Date();
                const expireDeblocage = new Date(maintenant.getTime() + 3 * 24 * 60 * 60 * 1000);

                await annonceRef.update({
                    statut_numero: "debloque",
                    date_deblocage: admin.firestore.Timestamp.fromDate(maintenant),
                    expire_deblocage: admin.firestore.Timestamp.fromDate(expireDeblocage),
                    titre_negociation: "En cours de négociation"
                });

                console.log("✅ Contact débloqué pour annonce :", annonceId);
            }
            return res.status(200).send("ok");
        }

        // ===== PUBLICATION ANNONCE =====
        switch (event.type) {
            case "intent.succeeded":
                console.log("✅ Paiement réussi pour annonce :", annonceId);
                if (!annonceData.paiementEffectue) {
                    const now = new Date();
                    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000; // 30 jours en ms
                    const newExpireAt = admin.firestore.Timestamp.fromDate(new Date(now.getTime() + THIRTY_DAYS));

                    const imagesUrls = [];
                    const imagesDeleteUrls = [];

                    if (annonceData.imagesTemp?.length > 0) {
                        for (const base64Image of annonceData.imagesTemp) {
                            const formData = new URLSearchParams();
                            formData.append("key", process.env.IMGBB_API_KEY);
                            formData.append("image", base64Image);
                            formData.append("expiration", 2592000); // 30 jours en secondes

                            try {
                                const response = await fetch("https://api.imgbb.com/1/upload", {
                                    method: "POST",
                                    body: formData
                                });
                                const data = await response.json();
                                if (data.success) {
                                    imagesUrls.push(data.data.url);
                                    imagesDeleteUrls.push(data.data.delete_url);
                                } else {
                                    console.error("Erreur upload Imgbb :", data);
                                }
                            } catch (err) {
                                console.error("Erreur fetch Imgbb :", err);
                            }
                        }
                    }

                    await annonceRef.update({
                        statut: "published",
                        paiementEffectue: true,
                        statut_numero: "verrouille",
                        updatedAt: admin.firestore.Timestamp.now(),
                        expireAt: newExpireAt,
                        images: imagesUrls,
                        imagesDeleteUrls: imagesDeleteUrls,
                        imagesTemp: admin.firestore.FieldValue.delete()
                    });
                    console.log("Annonce mise à jour en 'published'");
                } else {
                    console.log("⚠ Annonce déjà payée, mise à jour ignorée :", annonceId);
                }
                break;

            case "intent.failed":
            case "intent.canceled":
            case "intent.expired":
                console.log("⚠ Paiement échoué / annulé / expiré pour annonce :", annonceId);
                await rollbackAnnonce(annonceRef, annonceData);
                break;

            default:
                console.log("Événement inconnu :", event.type);
        }

        res.status(200).send("ok");

    } catch (err) {
        console.error("Erreur webhook Yabetoo :", err);
        res.status(500).send("Erreur serveur");
    }
});

// ==================================================
// ==================== PAIEMENT DÉBLOCAGE ====================
// ====================================================
app.post("/api/payment/deblocage", async (req, res) => {

    const { name, msisdn, provider, amount, annonceId, description, uid } = req.body;

    if (!name || !msisdn || !provider || !amount || !annonceId) {
        return res.status(400).json({ message: "Champs obligatoires manquants" });
    }

    try {

        const body = {
            accountId: YABETOOPAY_MERCHANT_ID,
            total: amount,
            currency: "xaf",

            successUrl: `https://chezmoi-app.netlify.app/#home`,
            cancelUrl: `https://chezmoi-app.netlify.app/#home`,

            metadata: {
                type: "deblocage_contact",
                annonceId: annonceId,
                msisdn: msisdn,
                uid: req.body.uid || ""
            },

            items: [
                {
                    productId: "deblocage_contact",
                    quantity: 1,
                    price: amount,
                    productName: description || "Déblocage contact propriétaire"
                },
                {
                    productId: "frais_yabetoopay",
                    quantity: 1,
                    price: 60, // frais que tu veux montrer
                    productName: "Frais de traitement Yabetoopay"
                }
            ]
        };

        const response = await fetch("https://buy.api.yabetoopay.com/v1/sessions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${YABETOOPAY_SECRET_KEY}`
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!data.url) {
            return res.status(400).json({
                message: "Erreur création paiement",
                details: data
            });
        }

        res.json({
            message: "Paiement initié",
            redirectUrl: data.url
        });

    } catch (error) {

        console.error("Erreur paiement debloquage :", error);

        res.status(500).json({
            message: error.message
        });

    }

});

/* ===================================================== */
/* ================== LANCEMENT SERVEUR =============== */
/* ===================================================== */
app.listen(PORT, () => {
    console.log(`Backend ChezMoi lancé sur ${PORT}`);
});