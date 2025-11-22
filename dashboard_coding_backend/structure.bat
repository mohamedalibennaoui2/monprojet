@echo off
echo Création de la structure du répertoire 'server/' pour TITAN V31.4...

:: Dossiers principaux
mkdir server
mkdir drizzle

:: Dossiers et fichiers dans 'server/'
mkdir server\_core
mkdir server\db
mkdir server\db\migrations
mkdir server\services
mkdir server\routers

:: Fichiers _core (Contexte tRPC, RLS, Cookies, etc.)
type nul > server\_core\context.ts
type nul > server\_core\cookies.ts
type nul > server\_core\env.ts
type nul > server\_core\errors.ts
type nul > server\_core\sdk.ts
type nul > server\_core\systemRouter.ts
type nul > server\_core\trpc.ts

:: Fichiers db (Connexion Drizzle, Contexte RLS)
type nul > server\db\database.ts
type nul > server\db\rls.ts
:: Le dossier migrations existe : server/db/migrations/

:: Fichiers services (Chiffrement PGP, Auth, Recherche, Stats)
type nul > server\services\pgp.ts
type nul > server\services\auth.ts
type nul > server\services\search.ts
type nul > server\services\stats.ts

:: Fichiers routers (Endpoints API)
type nul > server\routers\auth.ts
type nul > server\routers\users.ts
type nul > server\routers\centers.ts
type nul > server\routers\patients.ts
type nul > server\routers\appointments.ts
type nul > server\routers\encounters.ts
type nul > server\routers\invoices.ts
type nul > server\routers\doctors.ts
type nul > server\routers\pharmacy.ts
type nul > server\routers\prescriptions.ts
type nul > server\routers\documents.ts
type nul > server\routers\roles.ts
type nul > server\routers\stats.ts
type nul > server\routers\index.ts

:: Fichiers racine de server (DB helper, OAuth, Point d'entrée Express)
type nul > server\db.ts
type nul > server\oauth.ts
type nul > server\index.ts

:: Fichiers racine du projet
type nul > drizzle\schema.ts
type nul > .env.example
type nul > package.json
type nul > tsconfig.json

echo.
echo Structure de projet TITAN V31.4 générée avec succès !
pause