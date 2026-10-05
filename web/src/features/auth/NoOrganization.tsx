import { EmptyState } from "../../components/ui/Feedback";
import { AuthLayout } from "./AuthLayout";
import { CreateOrgForm } from "./CreateOrgForm";

/** Compte sans organisation (par exemple après la suppression de la dernière) : on propose d'en créer une. */
export function NoOrganization() {
  return (
    <AuthLayout title="Aucune organisation." subtitle="Ton compte n'appartient à aucune organisation pour l'instant. Crées-en une, ou demande une invitation à un administrateur.">
      <CreateOrgForm />
      <div className="mt-8"><EmptyState title="Une invitation ?" hint="Ouvre simplement le lien que l'on t'a transmis : il te fera rejoindre l'organisation." /></div>
    </AuthLayout>
  );
}
