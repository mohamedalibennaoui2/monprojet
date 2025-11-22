-- 1. CRÉATION DU PREMIER CENTRE OBLIGATOIRE
INSERT INTO centers (name, code, timezone, is_active)
VALUES ('Clinique Centrale Alpha', 'ALPHA01', 'Africa/Tunis', true)
RETURNING id;
-- NOTE: Récupérez l'UUID généré (ex: 'a1b2c3d4-...') et utilisez-le ci-dessous.

-- 2. CHANGEMENT DE LA CLÉ DE CRYPTAGE (CRITIQUE)
UPDATE system_settings 
SET value = '{"encryption_key": "VOTRE_CLÉ_DE_CRYPTAGE_256_BITS_ALÉATOIRE_GENERÉE"}'
WHERE key = 'encryption';

-- 3. CHANGEMENT DU MOT DE PASSE ADMIN PAR DÉFAUT (CRITIQUE)
UPDATE users 
SET hashed_password = crypt('VotreNouveauMotDePasseComplexe!2024', gen_salt('bf'))
WHERE username = 'admin';

-- 4. ASSIGNATION DE L'ADMIN AU CENTRE CRÉÉ (UUID du point 1)
UPDATE users 
SET center_id = 'UUID_DU_CENTRE_CRÉÉ'
WHERE username = 'admin';