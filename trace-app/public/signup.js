document.querySelector("#signup").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector("button"),
    message = document.querySelector("#message");
  button.disabled = true;
  message.textContent = "Creating your account…";
  try {
    const response = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.elements.email.value,
        password: form.elements.password.value,
      }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Could not create account.");
    form.elements.password.value = "";
    message.textContent = data.message;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
