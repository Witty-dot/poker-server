document.addEventListener("DOMContentLoaded", () => {
  function loadPartial(containerId, url, afterInsert) {
    const el = document.getElementById(containerId);
    if (!el) return;

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then((html) => {
        el.innerHTML = html;
        if (typeof afterInsert === "function") afterInsert();
      })
      .catch((err) => {
        console.error("Error loading partial:", containerId, url, err);
      });
  }

  // Хэдер
  loadPartial("site-header", "partials/header.html");

  // Футер + год
  loadPartial("site-footer", "partials/footer.html", () => {
    const yearEl = document.getElementById("year");
    if (yearEl) {
      yearEl.textContent = new Date().getFullYear();
    }
  });
});
