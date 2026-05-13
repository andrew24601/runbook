# RunDown Welcome

This workbook exists so the first native RunDown shell has something concrete to open.

```variables name="my_vars"
base_url = "https://jsonplaceholder.typicode.com"
user = "1"
```

The profile request uses the shared base URL and user variables, and runs automatically when those inputs change.

```http name="profile" auto="true"
GET {{my_vars.base_url}}/users/{{my_vars.user}}
Accept: application/json
```

The JSON viewer can bind directly to cached response data.

```json src="profile.body"
```

JavaScript cells can compute from any named outputs above them. This one reruns when the variables or profile response changes.

```javascript name="profileSummary"
if (typeof profile === "undefined" || !profile.body) {
  return { userId: my_vars.user, name: "", city: "" };
}

return {
  userId: my_vars.user,
  name: profile.body.name,
  city: profile.body.address.city
};
```

Markdown can reflect the cached response.

- Profile status: {{profile.status}}
- Profile name: {{profile.body.name}}
- Profile city: {{profileSummary.city}}
