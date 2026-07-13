import logo from "./logo.png";

console.log("resolved logo URL:", logo);

const img = document.createElement("img");
img.src = logo;
img.alt = "logo";
document.body.appendChild(img);
