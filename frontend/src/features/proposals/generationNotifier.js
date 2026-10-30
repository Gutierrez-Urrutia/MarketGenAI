// Aviso global al terminar una generación de propuesta (RF-VTA-01, C4).
// Vive fuera del modal: sigue funcionando aunque el usuario lo haya cerrado o cambiado de pantalla.
import toast from "react-hot-toast";

export function announceProposalGeneration({ ok, message }) {
  if (ok) {
    toast.success(message, { duration: 8000 });
    window.dispatchEvent(new CustomEvent("marketgen:content-library-updated"));
  } else {
    toast.error(message, { duration: 8000 });
  }
}
