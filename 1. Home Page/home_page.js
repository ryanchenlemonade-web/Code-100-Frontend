


// footer
fetch('../0.%20Footer/footer.html')
    .then(res => res.text())
    .then(html => {
        document.getElementById('footer-container').innerHTML = html;
    });